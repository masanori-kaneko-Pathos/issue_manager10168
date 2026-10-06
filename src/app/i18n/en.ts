import { Dict } from './ja';

export const en: Dict = {
  app: { title: 'Issue Tracker' },
  login: {
    google: 'Sign in with Google',
    or: 'or',
    email: 'Email',
    password: 'Password (6+ characters)',
    submit: 'Sign in',
    signup: 'Create account',
    toSignup: 'New here? Create an account',
    toLogin: 'Back to sign in',
    errors: {
      'invalid-credential': 'Incorrect email or password.',
      'email-already-in-use': 'This email is already registered.',
      'weak-password': 'Password must be at least 6 characters.',
      'invalid-email': 'Invalid email format.',
      default: 'Sign-in failed. Please try again.',
    },
  },
  home: { welcome: 'Welcome, {{name}}', logout: 'Sign out' },
  common: {
    logout: 'Sign out',
    loading: 'Loading…',
    loadError: 'Could not load. Please reload the page.',
    saveError: 'Could not save. Please try again.',
  },
  projects: {
    title: 'Projects',
    namePlaceholder: 'New project name',
    create: 'Create',
    empty: 'No projects yet. Create one above or accept an invitation.',
    archived: 'Archived',
  },
  roles: { admin: 'Admin', member: 'Member', viewer: 'Viewer' },
  labels: { customer: 'Customer', internal: 'Internal', spec: 'Spec & design', ops: 'Operations', quality: 'Quality' },

  project: {
    back: '← Projects',
    notFound: 'Project not found, or you do not have access.',
    members: 'Members',
    invite: 'Invite a member',
    inviteEmail: "Invitee's email",
    inviteSubmit: 'Invite',
    inviteError: 'Could not send the invitation. This person may already be invited.',
    pending: 'Pending invitations',
    cancelInvite: 'Cancel',
  },
  invitations: {
    title: 'Invitations',
    from: '{{name}} invited you to "{{project}}" as {{role}}',
    accept: 'Join',
    decline: 'Decline',
  },
  verify: {
    message: 'Your email is not verified. To accept invitations, click the link in the verification email, then press "I verified".',
    resend: 'Resend email',
    done: 'I verified',
    sent: 'Verification email sent.',
  },

};