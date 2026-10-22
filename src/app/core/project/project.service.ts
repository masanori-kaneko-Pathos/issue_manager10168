import { Injectable, inject } from '@angular/core';
import { User } from 'firebase/auth';
import {
    FirestoreError, Unsubscribe, collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, where,
    orderBy, limit,
    serverTimestamp, writeBatch, setDoc, deleteDoc, updateDoc, runTransaction, deleteField, DocumentReference,
} from 'firebase/firestore';
import { db, firebaseApp } from '../firebase';
import { AuthService } from '../auth/auth.service';
import { NotificationService } from '../notification/notification.service';
import { I18nService } from '../../i18n/i18n';
import {
    Activity, DEFAULT_LABEL_IDS, DEFAULT_SETTINGS, Invitation, IssueStatus, Label, Member, OPEN_STATUSES, Project,
    ProjectSettings, ProjectWithRole, Role, labelColor, ArchiveKind
} from '../models';

/** メンバーの変更の種類。null は担当の引き継ぎだけ */
export type MemberChange = { kind: 'role'; role: Role } | { kind: 'remove' } | { kind: 'leave' } | null;

@Injectable({ providedIn: 'root' })
export class ProjectService {
    private i18n = inject(I18nService);
    private authService = inject(AuthService);
    private notifications = inject(NotificationService);

    /** プロジェクトと「自分が管理者」のメンバー文書を、1回でまとめて作る */
    async create(name: string, user: User, opts: { sample?: boolean; description?: string } = {}): Promise<string> {
        const projectRef = doc(collection(db, 'projects'));
        const batch = writeBatch(db);
        batch.set(projectRef, {
            name,
            archived: false,
            createdBy: user.uid,
            createdAt: serverTimestamp(),
            labels: DEFAULT_LABEL_IDS.map((id) => {
                const l = { id, name: this.i18n.t(`labels.${id}`) };
                return { ...l, color: labelColor(l) };
            }),
            settings: DEFAULT_SETTINGS,
            issueSeq: 0,
            ...(opts.sample ? { sample: true } : {}),
            ...(opts.description ? { description: opts.description } : {}),
        });
        batch.set(doc(projectRef, 'members', user.uid), {
            uid: user.uid,
            role: 'admin',
            displayName: this.authService.myName(user),
            photoURL: user.photoURL ?? null,
            joinedAt: serverTimestamp(),
        });
        await batch.commit();
        return projectRef.id;
    }

    /** 自分が所属するプロジェクトの一覧（ロールつき） */
    async listMyProjects(uid: string): Promise<ProjectWithRole[]> {
        const snap = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', uid)));
        const list = await Promise.all(
            snap.docs.map(async (m): Promise<ProjectWithRole | null> => {
                const p = await getDoc(m.ref.parent.parent!);
                if (!p.exists()) return null;
                // 参加した日時も一緒に返す（メンバー文書はもう読んでいるので、読む回数は増えない）
                return {
                    ...(p.data() as Omit<Project, 'id'>), id: p.id, role: m.data()['role'] as Role,
                    joinedAt: m.data()['joinedAt'] as ProjectWithRole['joinedAt'],
                };
            }),
        );
        return list
            .filter((p): p is ProjectWithRole => p !== null)
            .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
    }

    async get(pid: string): Promise<Project | null> {
        const s = await getDoc(doc(db, 'projects', pid));
        return s.exists() ? { ...(s.data() as Omit<Project, 'id'>), id: s.id } : null;
    }


    async myRole(pid: string, uid: string): Promise<Role | null> {
        const s = await getDoc(doc(db, 'projects', pid, 'members', uid));
        return s.exists() ? (s.data()['role'] as Role) : null;
    }

    async listMembers(pid: string): Promise<Member[]> {
        const s = await getDocs(collection(db, 'projects', pid, 'members'));
        return s.docs.map((d) => d.data() as Member)
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    /** メンバー一覧を見張る（役割の変更や、外されたことがすぐ届く） */
    watchMembers(
        pid: string, onData: (members: Member[]) => void, onError: (e: FirestoreError) => void,
    ): Unsubscribe {
        return onSnapshot(
            collection(db, 'projects', pid, 'members'),
            (s) => onData(s.docs.map((d) => d.data({ serverTimestamps: 'estimate' }) as Member)
                .sort((a, b) => a.displayName.localeCompare(b.displayName))),
            onError,
        );
    }


    /** プロジェクトの文書を見張る（設定・ラベル・名前・アーカイブの変更が、すぐ全員に届く） */
    watchProject(
        pid: string, onData: (project: Project | null) => void, onError: (e: FirestoreError) => void,
    ): Unsubscribe {
        return onSnapshot(
            doc(db, 'projects', pid),
            (s) => onData(s.exists()
                ? { ...(s.data({ serverTimestamps: 'estimate' }) as Omit<Project, 'id'>), id: s.id }
                : null),
            onError,
        );
    }

    /** 動きの帳面の新しい n 件を見張る（概要の「直近の経緯」） */
    watchActivity(
        pid: string, n: number, onData: (list: Activity[]) => void, onError: (e: FirestoreError) => void,
    ): Unsubscribe {
        return onSnapshot(
            query(collection(db, 'projects', pid, 'activity'), orderBy('at', 'desc'), limit(n)),
            (s) => onData(s.docs.map((d) => ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Activity, 'id'>), id: d.id }))),
            onError,
        );
    }

    async listInvitations(pid: string): Promise<Invitation[]> {
        const s = await getDocs(collection(db, 'projects', pid, 'invitations'));
        return s.docs.map((d) => ({ ...(d.data() as Omit<Invitation, 'projectId'>), projectId: pid }));
    }

    /**
     * 招待（管理者のみ）。関数に頼む（もうメンバーの人・招待済みの人には送らない）。
     * 失敗の理由は、今までどおり Error のメッセージで返す（already-invited / already-member / invite-failed）
     */
    async invite(project: Project, email: string, role: Role, _inviter: User) {
        // 関数の窓口は、使うときだけ読み込む（最初の画面を軽く保つため）
        const { getFunctions, httpsCallable } = await import('firebase/functions');
        const call = httpsCallable(getFunctions(firebaseApp, 'asia-northeast1'), 'imInvite');
        try {
            await call({ pid: project.id, email, role });
        } catch (e) {
            // 関数の理由の文は、前後に飾りが付いて届くことがあるので、「含まれているか」で見る
            const msg = (e as { message?: string }).message ?? '';
            const reason = ['already-invited', 'already-member'].find((r) => msg.includes(r));
            // 理由の分からない失敗は、元のエラーを残す（あとで調べられるように）
            if (!reason) console.error('招待の関数のエラー', e);
            throw new Error(reason ?? 'invite-failed');
        }
    }

    cancelInvitation(pid: string, email: string) {
        return deleteDoc(doc(db, 'projects', pid, 'invitations', email));
    }

    /** 自分宛ての招待（メール確認済みのときだけ読める） */
    async listMyInvitations(email: string): Promise<Invitation[]> {
        const s = await getDocs(
            query(collectionGroup(db, 'invitations'), where('email', '==', email.toLowerCase())),
        );
        return s.docs.map((d) => ({
            ...(d.data() as Omit<Invitation, 'projectId'>),
            projectId: d.ref.parent.parent!.id,
        }));
    }
    /** 自分宛ての招待を見張る（メール確認済みのときだけ読める） */
    watchMyInvitations(
        email: string, onData: (invitations: Invitation[]) => void, onError: (e: FirestoreError) => void,
    ): Unsubscribe {
        return onSnapshot(
            query(collectionGroup(db, 'invitations'), where('email', '==', email.toLowerCase())),
            (s) => onData(s.docs.map((d) => ({
                ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Invitation, 'projectId'>),
                projectId: d.ref.parent.parent!.id,
            }))),
            onError,
        );
    }

    /** 承諾：自分のメンバー文書の作成と、招待の削除を同時に行う */
    async acceptInvitation(inv: Invitation, user: User) {
        // もうメンバーなら、招待を消すだけ（書き直すと「書き換え」扱いになり、ルールに断られて招待が残ってしまう）。
        // メンバーでなければ、メンバー文書は読めずに断られるので、そのときは「まだメンバーではない」とみなす
        const memberRef = doc(db, 'projects', inv.projectId, 'members', user.uid);
        const already = await getDoc(memberRef).then((s) => s.exists()).catch(() => false);
        if (already) {
            await deleteDoc(doc(db, 'projects', inv.projectId, 'invitations', inv.email));
            return;
        }
        const batch = writeBatch(db);
        batch.set(doc(db, 'projects', inv.projectId, 'members', user.uid), {
            uid: user.uid,
            role: inv.role,
            displayName: this.authService.myName(user),
            photoURL: user.photoURL ?? null,
            joinedAt: serverTimestamp(),
        });
        batch.delete(doc(db, 'projects', inv.projectId, 'invitations', inv.email));
        await batch.commit();
        // 招待した人に知らせる（おまけ）。承諾のあとに別に書く：承諾する前は、招待した人が今もメンバーかを
        // 読めないため。招待した人が抜けていれば断られるが、承諾はもう済んでいるので、失敗は記録だけにする
        const n = this.notifications.notice(inv.invitedBy, 'joined', {
            pid: inv.projectId, projectName: inv.projectName, iid: null, issueNumber: null, issueTitle: '',
        });
        if (n) await setDoc(n.ref, n.data).catch((e) => console.warn('参加の知らせを送れませんでした', e));
    }

    declineInvitation(inv: Invitation) {
        return deleteDoc(doc(db, 'projects', inv.projectId, 'invitations', inv.email));
    }
    /** ラベルの一覧をまるごと保存する（管理者のみ。ルールで確認） */
    updateLabels(pid: string, labels: Label[]) {
        return updateDoc(doc(db, 'projects', pid), { labels });
    }

    /** 通知時刻・日数・件数の設定を保存する（管理者のみ。形と範囲はルールで確認） */
    updateSettings(pid: string, settings: ProjectSettings) {
        return updateDoc(doc(db, 'projects', pid), { settings });
    }

    /**
     * 設定の、変えた欄だけを保存する（管理者が2人同時に触っても、別々の欄なら両方残る）。
     * 名前は settings の中の場所（'staleDays'、'features.gantt' など）。形と範囲はルールで確かめる
     */
    updateSettingFields(pid: string, fields: Record<string, number | boolean>) {
        return updateDoc(doc(db, 'projects', pid),
            Object.fromEntries(Object.entries(fields).map(([k, v]) => [`settings.${k}`, v])));
    }

    /** プロジェクト名を変える（管理者のみ。1〜100文字の文字列かはルールで確認） */
    rename(pid: string, name: string) {
        return updateDoc(doc(db, 'projects', pid), { name });
    }

    /** 概要の説明を変える（管理者のみ。5000字までかはルールで確認） */
    setDescription(pid: string, description: string) {
        return updateDoc(doc(db, 'projects', pid), { description });
    }

    /** アーカイブ（管理者のみ）：全員が閲覧専用になり、通知も止まる。管理ログにも残す（追加の取り決め） */
    async archive(pid: string, kind: ArchiveKind, reason: string, by: string, role: Role) {
        const batch = writeBatch(db);
        batch.update(doc(db, 'projects', pid), {
            archived: true, archiveKind: kind, archiveReason: reason, archivedAt: serverTimestamp(), archivedBy: by,
        });
        batch.set(doc(collection(db, 'projects', pid, 'adminLogs')), {
            type: 'archive', by, target: by, from: role, to: null, moved: 0, at: serverTimestamp(),
        });
        await batch.commit();
    }

    /** アーカイブの解除（管理者のみ）：アーカイブの情報を消して、元どおりにする */
    async unarchive(pid: string, by: string, role: Role) {
        const batch = writeBatch(db);
        batch.update(doc(db, 'projects', pid), {
            archived: false, archiveKind: deleteField(), archiveReason: deleteField(),
            archivedAt: deleteField(), archivedBy: deleteField(),
        });
        batch.set(doc(collection(db, 'projects', pid, 'adminLogs')), {
            type: 'unarchive', by, target: by, from: role, to: null, moved: 0, at: serverTimestamp(),
        });
        await batch.commit();
    }

    /** プロジェクトを完全に削除する（関数に頼む。条件は関数の中で確かめる） */
    async deleteProject(pid: string, name: string) {
        // 関数の窓口は、使うときだけ読み込む（最初の画面を軽く保つため）
        const { getFunctions, httpsCallable } = await import('firebase/functions');
        const call = httpsCallable(getFunctions(firebaseApp, 'asia-northeast1'), 'imDeleteProject');
        await call({ pid, name });
    }

    /**
     * 引き継ぎで動かすサブタスク（トランザクションの中では検索できないので、先に集める）。
     * 渡し先は、親の課題の担当者（その課題も引き継ぐなら、引き継ぐ人）。
     * leaving＝外す・閲覧者にする・抜ける（全部動かす）。担当を渡すだけなら、渡した課題の中のものだけ
     */
    private async subtasksToMove(pid: string, uid: string, dests: Record<string, string>, leaving: boolean) {
        const projectRef = doc(db, 'projects', pid);
        const [issues, members] = await Promise.all([
            getDocs(query(collection(projectRef, 'issues'), where('subtaskAssignees', 'array-contains', uid))),
            getDocs(collection(projectRef, 'members')),
        ]);
        // 担当者になれる人（本人と閲覧者は除く）
        const workers = new Set(members.docs
            .filter((m) => m.id !== uid && m.data()['role'] !== 'viewer').map((m) => m.id));
        const out: { ref: DocumentReference; to: string }[] = [];
        for (const i of issues.docs) {
            const d = i.data();
            // 終わった課題の中のサブタスクは、記録として残す
            if (!OPEN_STATUSES.includes(d['status'] as IssueStatus)) continue;
            if (!leaving && !dests[i.id]) continue;
            const to = dests[i.id] ?? (d['assigneeId'] as string);
            // 親の担当者も、もういない人なら動かさない（ルールで「担当者になれる人か」を確かめているため）
            if (!workers.has(to)) continue;
            const subs = await getDocs(query(collection(i.ref, 'subtasks'), where('assigneeId', '==', uid)));
            for (const s of subs.docs) {
                if (s.data()['status'] !== 'done' && !s.data()['splitTo']) out.push({ ref: s.ref, to });
            }
        }
        return out;
    }

    /**
     * 担当の引き継ぎと、役割の変更・外す・抜けるを、1つのトランザクションで行う（全部か無か）。
     * dests は「課題id → 引き継ぐ人」。課題ごとに渡す人を分けられる（渡さない課題は入れない）
     */
    async changeMember(
        pid: string, target: Member, dests: Record<string, string>, reason: string,
        change: MemberChange, by: string, tz: string,
        recur: Record<string, { assigneeId?: string; createdBy?: string }> = {},
    ) {
        const projectRef = doc(db, 'projects', pid);
        const memberRef = doc(projectRef, 'members', target.uid);
        const ids = Object.keys(dests);
        // 外す・閲覧者にする・抜ける：サブタスクを全部動かす。担当を渡すだけ・管理者やメンバーへの役割の変更：渡した課題の中だけ
        const leaving = change !== null && (change.kind !== 'role' || change.role === 'viewer');
        const subs = await this.subtasksToMove(pid, target.uid, dests, leaving);
        await runTransaction(db, async (tx) => {
            // トランザクションは「読むのが先、書くのは後」の決まり
            const [project, ...snaps] = await Promise.all([
                tx.get(projectRef),
                ...ids.map((id) => tx.get(doc(projectRef, 'issues', id))),
            ]);
            const subSnaps = await Promise.all(subs.map((s) => tx.get(s.ref)));
            /** 受け取った人ごとの件数（通知を1人1通にまとめるため） */
            const movedTo: Record<string, number> = {};
            snaps.forEach((s, k) => {
                const to = dests[ids[k]];
                if (!s.exists() || !to) return;
                const d = s.data();
                // 開いてから今までに、ほかの人が担当を変えた・クローズしたものは触らない
                if (d['assigneeId'] !== target.uid || !OPEN_STATUSES.includes(d['status'] as IssueStatus)) return;
                tx.update(s.ref, { assigneeId: to, updatedAt: serverTimestamp(), updatedBy: by });
                tx.set(doc(collection(s.ref, 'events')), {
                    type: 'edit', fields: ['assigneeId'], changes: { assigneeId: { from: target.uid, to } },
                    reason, by, tz, at: serverTimestamp(),
                });
                movedTo[to] = (movedTo[to] ?? 0) + 1;
            });
            // サブタスク：集めたあとで変わったもの（ほかの人が担当を替えた・完了にした）は触らない
            subSnaps.forEach((s, k) => {
                const d = s.data();
                if (!d || d['assigneeId'] !== target.uid || d['status'] === 'done' || d['splitTo']) return;
                tx.update(s.ref, { assigneeId: subs[k].to, updatedAt: serverTimestamp(), updatedBy: by });
            });
            const moved = Object.values(movedTo).reduce((a, b) => a + b, 0);
            // 定期課題の雛形：次の回からの担当・作った人を、同じ封筒で替える（読む必要はないので、書くだけ）
            for (const [rid, u] of Object.entries(recur)) {
                tx.update(doc(projectRef, 'recurring', rid), { ...u, updatedAt: serverTimestamp() });
            }
            if (change?.kind === 'role') tx.update(memberRef, { role: change.role });
            if (change?.kind === 'remove' || change?.kind === 'leave') {
                // 名前を残してから消す（コメントや経緯で「—」にしないため）
                tx.update(projectRef, { [`formerMembers.${target.uid}`]: target.displayName });
                tx.delete(memberRef);
            }
            tx.set(doc(collection(projectRef, 'adminLogs')), {
                type: change?.kind ?? 'handover', by, target: target.uid, from: target.role,
                to: change?.kind === 'role' ? change.role : null, moved, at: serverTimestamp(),
            });
            // 引き継いだ人に、1人1通（件数は issueNumber に入れる）
            for (const [to, n] of Object.entries(movedTo)) {
                const notice = this.notifications.notice(to, 'handover', {
                    pid, projectName: project.data()?.['name'] ?? '', iid: null, issueNumber: n, issueTitle: '',
                }, reason);
                if (notice) tx.set(notice.ref, notice.data);
            }
        });
    }
}