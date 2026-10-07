import { Injectable, inject } from '@angular/core';
import { User } from 'firebase/auth';
import {
    collection, collectionGroup, doc, getDoc, getDocs, query, where,
    serverTimestamp, writeBatch, setDoc, deleteDoc, updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import { I18nService } from '../i18n/i18n';
import {
    DEFAULT_LABEL_IDS, DEFAULT_SETTINGS, Invitation, Label, Member, Project, ProjectWithRole, Role, labelColor,
} from './models';

@Injectable({ providedIn: 'root' })
export class ProjectService {
    private i18n = inject(I18nService);

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
            displayName: user.displayName ?? user.email?.split('@')[0] ?? '',
            photoURL: user.photoURL ?? null,
            joinedAt: serverTimestamp(),
        });
        await batch.commit();
        return projectRef.id;
    }

    /** 自分が所属するプロジェクトの一覧（ロールつき） */
    async listMine(uid: string): Promise<ProjectWithRole[]> {
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
            invitedByName: inviter.displayName ?? inviter.email ?? '',
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

    /** 承諾：自分のメンバー文書の作成と、招待の削除を同時に行う */
    async acceptInvitation(inv: Invitation, user: User) {
        const batch = writeBatch(db);
        batch.set(doc(db, 'projects', inv.projectId, 'members', user.uid), {
            uid: user.uid,
            role: inv.role,
            displayName: user.displayName ?? user.email?.split('@')[0] ?? '',
            photoURL: user.photoURL ?? null,
            joinedAt: serverTimestamp(),
        });
        batch.delete(doc(db, 'projects', inv.projectId, 'invitations', inv.email));
        await batch.commit();
    }

    declineInvitation(inv: Invitation) {
        return deleteDoc(doc(db, 'projects', inv.projectId, 'invitations', inv.email));
    }
    /** ラベルの一覧をまるごと保存する（管理者のみ。ルールで確認） */
    updateLabels(pid: string, labels: Label[]) {
        return updateDoc(doc(db, 'projects', pid), { labels });
    }
}