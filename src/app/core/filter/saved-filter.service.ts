import { Injectable } from '@angular/core';
import {
  FirestoreError, Unsubscribe, addDoc, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, updateDoc, where,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { SavedFilter } from '../models';

/** 1プロジェクトに保存できる数（ルールは数えられないので、画面で守る） */
export const MAX_SAVED_FILTERS = 20;

/** 保存した絞り込み（自分だけ）。見張る・保存する・上書きする・消す */
@Injectable({ providedIn: 'root' })
export class SavedFilterService {
  private col() {
    return collection(db, 'users', auth.currentUser!.uid, 'filters');
  }

  /** このプロジェクトの分を、名前順で見張る */
  watch(pid: string, onData: (list: SavedFilter[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    const q = query(this.col(), where('pid', '==', pid));
    return onSnapshot(q, (s) => {
      const list = s.docs.map((d) => ({ ...(d.data() as Omit<SavedFilter, 'id'>), id: d.id }));
      list.sort((a, b) => a.name.localeCompare(b.name));
      onData(list);
    }, onError);
  }

  add(pid: string, name: string, q: string) {
    return addDoc(this.col(), {
      name: name.slice(0, 50), pid, query: q, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  }

  /** 同じ名前で保存し直した：条件だけ置き換える */
  overwrite(id: string, q: string) {
    return updateDoc(doc(this.col(), id), { query: q, updatedAt: serverTimestamp() });
  }

  remove(id: string) {
    return deleteDoc(doc(this.col(), id));
  }
}