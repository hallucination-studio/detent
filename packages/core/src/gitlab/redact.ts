export const redactGitUrl = (text: string, secret?: string) =>
  (secret ? text.replaceAll(secret, '***') : text).replace(/(https?:\/\/oauth2:)[^\s/@]+@/gi, '$1***@');
