import { Injectable, inject } from '@angular/core';
import { User } from 'firebase/auth';
import {
    FirestoreError, Unsubscribe, collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, where,
    serverTimestamp, writeBatch, setDoc, deleteDoc, updateDoc, runTransaction, deleteField,
} from 'firebase/firestore';
import { db, firebaseApp } from '../firebase';
import { AuthService } from '../auth/auth.service';
import { NotificationService } from '../notification/notification.service';
import { I18nService } from '../../i18n/i18n';
import {
    DEFAULT_LABEL_IDS, DEFAULT_SETTINGS, Invitation, IssueStatus, Label, Member, OPEN_STATUSES, Project,
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
    async create(name: string, user: User): Promise<string> {
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
            snap.docs.map(async (m) => {
                const p = await getDoc(m.ref.parent.parent!);
                if (!p.exists()) return null;
                return { ...(p.data() as Omit<Project, 'id'>), id: p.id, role: m.data()['role'] as Role };
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

    async listInvitations(pid: string): Promise<Invitation[]> {
        const s = await getDocs(collection(db, 'projects', pid, 'invitations'));
        return s.docs.map((d) => ({ ...(d.data() as Omit<Invitation, 'projectId'>), projectId: pid }));
    }

    /** 招待（管理者のみ）。同じメールアドレスへの二重招待はエラーにする */
    async invite(project: Project, email: string, role: Role, inviter: User) {
        const ref = doc(db, 'projects', project.id, 'invitations', email);
        if ((await getDoc(ref)).exists()) throw new Error('already-invited');
        await setDoc(ref, {
            email,
            role,
            projectName: project.name,
            invitedBy: inviter.uid,
            invitedByName: this.authService.myName(inviter),
            createdAt: serverTimestamp(),
        });
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

    /** プロジェクト名を変える（管理者のみ。1〜100文字の文字列かはルールで確認） */
    rename(pid: string, name: string) {
        return updateDoc(doc(db, 'projects', pid), { name });
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

    /*途中で止まって「担当者がプロジェクトにいない課題」が残らないようにするため*/

    async changeMember(
        pid: string, target: Member, issueIds: string[], to: string | null, reason: string,
        change: MemberChange, by: string, tz: string,
    ) {
        const projectRef = doc(db, 'projects', pid);
        const memberRef = doc(projectRef, 'members', target.uid);
        await runTransaction(db, async (tx) => {
            // トランザクションは「読むのが先、書くのは後」の決まり
            const [project, ...snaps] = await Promise.all([
                tx.get(projectRef),
                ...issueIds.map((id) => tx.get(doc(projectRef, 'issues', id))),
            ]);
            let moved = 0;
            for (const s of snaps) {
                if (!s.exists() || !to) continue;
                const d = s.data();
                // 開いてから今までに、ほかの人が担当を変えた・クローズしたものは触らない
                if (d['assigneeId'] !== target.uid || !OPEN_STATUSES.includes(d['status'] as IssueStatus)) continue;
                tx.update(s.ref, { assigneeId: to, updatedAt: serverTimestamp(), updatedBy: by });
                tx.set(doc(collection(s.ref, 'events')), {
                    type: 'edit', fields: ['assigneeId'], changes: { assigneeId: { from: target.uid, to } },
                    reason, by, tz, at: serverTimestamp(),
                });
                moved++;
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
            // 引き継いだ人に、まとめて1通（件数は issueNumber に入れる）
            if (to && moved > 0) {
                const n = this.notifications.notice(to, 'handover', {
                    pid, projectName: project.data()?.['name'] ?? '', iid: null, issueNumber: moved, issueTitle: '',
                }, reason);
                if (n) tx.set(n.ref, n.data);
            }
        });
    }
}