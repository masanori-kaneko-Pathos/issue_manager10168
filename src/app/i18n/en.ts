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
};