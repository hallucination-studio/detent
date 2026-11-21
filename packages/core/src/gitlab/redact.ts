export const redactGitUrl = (text: string) => text.replace(/(https?:\/\/oauth2:)[^\s/@]+@/gi, '$1***@');
