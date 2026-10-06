export const ja = {
    app: { title: '課題管理' },
    login: {
      google: 'Googleでログイン',
      or: 'または',
      email: 'メールアドレス',
      password: 'パスワード（6文字以上）',
      submit: 'ログイン',
      signup: 'アカウントを作成',
      toSignup: 'はじめての方：アカウントを作成',
      toLogin: 'ログインに戻る',
      errors: {
        'invalid-credential': 'メールアドレスまたはパスワードが違います。',
        'email-already-in-use': 'このメールアドレスは登録済みです。',
        'weak-password': 'パスワードは6文字以上にしてください。',
        'invalid-email': 'メールアドレスの形式が正しくありません。',
        default: 'ログインできませんでした。もう一度お試しください。',
      },
    },
    home: { welcome: 'ようこそ、{{name}} さん', logout: 'ログアウト' },
  };
  export type Dict = typeof ja;