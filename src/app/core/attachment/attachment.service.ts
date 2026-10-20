import { Injectable } from '@angular/core';
import {
  FirestoreError, Unsubscribe, collection, doc, onSnapshot, orderBy, query, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db, firebaseApp } from '../firebase';
import { Attachment, MAX_FILE_BYTES } from '../models';

/** 置ける種類（Storage のルールと同じにすること） */
const TYPE_RE = /^(image\/(png|jpeg|gif|webp|heic|heif)|application\/pdf|text\/plain|text\/csv|application\/msword|application\/vnd\.ms-excel|application\/vnd\.ms-powerpoint|application\/vnd\.openxmlformats-officedocument\..*)$/;

/** 縮める画像の長い辺 */
const MAX_SIDE = 2000;
/** これより小さく、2000px 以内の画像は、縮めずにそのまま上げる（スクリーンショットの文字をにじませないため） */
const SMALL_IMAGE = 1024 * 1024;
/** 縮める前の画像として受け付ける大きさ（縮めたあとに、10MB 以内かを確かめる） */
const MAX_IMAGE_SOURCE = 50 * 1024 * 1024;

/** 上げる前に縮める画像か（GIF は動きが止まってしまうので縮めない） */
function shrinkable(type: string) {
  return type.startsWith('image/') && type !== 'image/gif';
}

/** 置けるファイルか（置けなければ理由の翻訳キーの末尾） */
export function checkFile(f: File): 'tooBig' | 'badType' | null {
  if (!TYPE_RE.test(f.type)) return 'badType';
  if (f.size > (shrinkable(f.type) ? MAX_IMAGE_SOURCE : MAX_FILE_BYTES)) return 'tooBig';
  return null;
}

/**
 * 画像を、長い辺2000px・JPEG（品質0.85）に縮める。小さい画像・GIF・この端末で読めない画像は、そのまま。
 * 縮めたほうが大きくなったら、元のまま
 */
export async function shrinkImage(f: File): Promise<File> {
  if (!shrinkable(f.type)) return f;
  let bmp: ImageBitmap;
  try {
    // 写真の向き（スマホで縦に撮ったもの）を、写真の情報どおりに直して読む
    bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
  } catch {
    return f;
  }
  const long = Math.max(bmp.width, bmp.height);
  if (long <= MAX_SIDE && f.size <= SMALL_IMAGE) {
    bmp.close();
    return f;
  }
  const scale = Math.min(1, MAX_SIDE / long);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // 透明の部分は白に（JPEG は透明を持てないため）
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob || blob.size >= f.size) return f;
  return new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

/** 添付：上げる・一覧を見張る・消す・開く */
@Injectable({ providedIn: 'root' })
export class AttachmentService {
  /** 添付の一覧の置き場所：課題（iid あり）か、プロジェクトの概要（iid が null） */
  private col(pid: string, iid: string | null) {
    return iid
      ? collection(db, 'projects', pid, 'issues', iid, 'attachments')
      : collection(db, 'projects', pid, 'files');
  }

  /** Storage の道具を、使うときだけ読み込む */
  private async storage() {
    const m = await import('firebase/storage');
    return { ...m, st: m.getStorage(firebaseApp) };
  }

  /** この課題の添付を見張る（課題への添付も、コメントへの添付も。古い順） */
  watch(pid: string, iid: string | null, onData: (list: Attachment[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(query(this.col(pid, iid), orderBy('at')),
      (s) => onData(s.docs.map((d) => ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Attachment, 'id'>), id: d.id }))),
      onError);
  }

  /**
   * 上げる → 一覧に書く。課題への添付は、経緯にも残す（同じ封筒で）。
   * 一覧に書けなかったら、上げたファイルを消して、エラーを投げ直す（一覧にないファイルを残さない）
   */
  async upload(
    pid: string, iid: string | null, file: File, uid: string, tz: string,
    opts: { cid?: string; onProgress?: (p: number) => void } = {},
  ) {
    // 画像は縮めてから上げる。縮めても10MBを超えるものは止める（ルールでも断られる）
    file = await shrinkImage(file);
    if (file.size > MAX_FILE_BYTES) throw new Error('tooBig');
    const ref = doc(this.col(pid, iid));
    // 倉庫の道：プロジェクトの概要・コメント・課題で分ける（ルールの道と同じ）
    const path = !iid ? `projects/${pid}/overview/${ref.id}`
      : opts.cid ? `projects/${pid}/issues/${iid}/c/${opts.cid}/${ref.id}`
        : `projects/${pid}/issues/${iid}/${ref.id}`;
    const s = await this.storage();
    const fileRef = s.ref(s.st, path);
    const task = s.uploadBytesResumable(fileRef, file, { contentType: file.type, customMetadata: { by: uid } });
    await new Promise<void>((resolve, reject) => task.on('state_changed',
      (snap) => opts.onProgress?.(snap.totalBytes ? snap.bytesTransferred / snap.totalBytes : 0), reject, () => resolve()));
    const name = file.name.slice(0, 200);
    try {
      const batch = writeBatch(db);
      batch.set(ref, {
        name, size: file.size, type: file.type, path, ...(opts.cid ? { cid: opts.cid } : {}), by: uid, at: serverTimestamp(),
      });
      // 経緯に残すのは、課題への添付だけ（プロジェクトには経緯がない。コメントはコメント自体が残る）
      if (iid && !opts.cid) {
        batch.set(doc(collection(db, 'projects', pid, 'issues', iid, 'events')), {
          type: 'attachment', file: { action: 'add', name }, by: uid, tz, at: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch (e) {
      await s.deleteObject(fileRef).catch(() => undefined);
      throw e;
    }
  }

  /** 消す：一覧の文書を消す（ファイル本体は関数が消す）。課題への添付は、経緯にも残す */
  async remove(pid: string, iid: string | null, a: Attachment, uid: string, tz: string) {
    const batch = writeBatch(db);
    batch.delete(doc(this.col(pid, iid), a.id));
    if (iid && !a.cid) {
      batch.set(doc(collection(db, 'projects', pid, 'issues', iid, 'events')), {
        type: 'attachment', file: { action: 'remove', name: a.name }, by: uid, tz, at: serverTimestamp(),
      });
    }
    await batch.commit();
  }

  /** CSV・テキストの中身を、文字にして読む（文字コードは、インポートと同じく UTF-8 → だめなら Shift_JIS） */
  async textOf(a: Attachment): Promise<string> {
    const s = await this.storage();
    const { decode } = await import('../import/parse');
    return decode(await s.getBytes(s.ref(s.st, a.path)));
  }

  /** 開くための URL（押したときだけ読む） */
  async urlOf(a: Attachment) {
    const s = await this.storage();
    return s.getDownloadURL(s.ref(s.st, a.path));
  }
}