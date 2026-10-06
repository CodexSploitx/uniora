export type EmailLocale = "en" | "es" | "pt" | "fr" | "de" | "it";

export interface InvitationStrings {
  /** `{org}` is replaced (and escaped by the renderer). */
  subject: string;
  preheader: string;
  heading: string;
  /** With a known inviter: `{inviter}` and `{org}`. */
  introWithInviter: string;
  intro: string;
  roleOne: string;
  roleMany: string;
  button: string;
  expires: string;
  fallback: string;
  ignore: string;
  sentBy: string;
  help: string;
}

export const DEFAULT_LOCALE: EmailLocale = "en";

export const STRINGS: Record<EmailLocale, InvitationStrings> = {
  en: {
    subject: "You're invited to join {org}",
    preheader: "Accept your invitation to join {org}.",
    heading: "You're invited to join {org}",
    introWithInviter: "{inviter} has invited you to join {org}.",
    intro: "You have been invited to join {org}.",
    roleOne: "Your role",
    roleMany: "Your roles",
    button: "Accept invitation",
    expires: "This invitation expires on {date}.",
    fallback: "If the button doesn't work, copy and paste this link into your browser:",
    ignore: "Weren't expecting this? You can safely ignore this e-mail — nothing happens until you accept.",
    sentBy: "Sent by {brand}",
    help: "Questions? Contact {support}.",
  },
  es: {
    subject: "Te invitaron a unirte a {org}",
    preheader: "Acepta tu invitación para unirte a {org}.",
    heading: "Te invitaron a unirte a {org}",
    introWithInviter: "{inviter} te ha invitado a unirte a {org}.",
    intro: "Has sido invitado/a a unirte a {org}.",
    roleOne: "Tu rol",
    roleMany: "Tus roles",
    button: "Aceptar invitación",
    expires: "Esta invitación vence el {date}.",
    fallback: "Si el botón no funciona, copia y pega este enlace en tu navegador:",
    ignore: "¿No esperabas esto? Puedes ignorar este correo sin problema: no pasa nada hasta que aceptes.",
    sentBy: "Enviado por {brand}",
    help: "¿Dudas? Escribe a {support}.",
  },
  pt: {
    subject: "Você foi convidado(a) para entrar em {org}",
    preheader: "Aceite o convite para entrar em {org}.",
    heading: "Você foi convidado(a) para entrar em {org}",
    introWithInviter: "{inviter} convidou você para entrar em {org}.",
    intro: "Você foi convidado(a) para entrar em {org}.",
    roleOne: "Seu papel",
    roleMany: "Seus papéis",
    button: "Aceitar convite",
    expires: "Este convite expira em {date}.",
    fallback: "Se o botão não funcionar, copie e cole este link no navegador:",
    ignore: "Não esperava por isso? Pode ignorar este e-mail com segurança: nada acontece até você aceitar.",
    sentBy: "Enviado por {brand}",
    help: "Dúvidas? Fale com {support}.",
  },
  fr: {
    subject: "Vous êtes invité(e) à rejoindre {org}",
    preheader: "Acceptez votre invitation à rejoindre {org}.",
    heading: "Vous êtes invité(e) à rejoindre {org}",
    introWithInviter: "{inviter} vous invite à rejoindre {org}.",
    intro: "Vous avez été invité(e) à rejoindre {org}.",
    roleOne: "Votre rôle",
    roleMany: "Vos rôles",
    button: "Accepter l'invitation",
    expires: "Cette invitation expire le {date}.",
    fallback: "Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :",
    ignore: "Vous n'attendiez rien ? Ignorez simplement cet e-mail : rien ne se passe tant que vous n'acceptez pas.",
    sentBy: "Envoyé par {brand}",
    help: "Une question ? Contactez {support}.",
  },
  de: {
    subject: "Einladung zu {org}",
    preheader: "Nehmen Sie die Einladung zu {org} an.",
    heading: "Sie wurden zu {org} eingeladen",
    introWithInviter: "{inviter} hat Sie zu {org} eingeladen.",
    intro: "Sie wurden zu {org} eingeladen.",
    roleOne: "Ihre Rolle",
    roleMany: "Ihre Rollen",
    button: "Einladung annehmen",
    expires: "Diese Einladung läuft am {date} ab.",
    fallback: "Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser:",
    ignore: "Nicht erwartet? Sie können diese E-Mail ignorieren – ohne Ihre Zusage passiert nichts.",
    sentBy: "Gesendet von {brand}",
    help: "Fragen? Schreiben Sie an {support}.",
  },
  it: {
    subject: "Sei stato/a invitato/a a unirti a {org}",
    preheader: "Accetta l'invito a unirti a {org}.",
    heading: "Sei stato/a invitato/a a unirti a {org}",
    introWithInviter: "{inviter} ti ha invitato/a a unirti a {org}.",
    intro: "Sei stato/a invitato/a a unirti a {org}.",
    roleOne: "Il tuo ruolo",
    roleMany: "I tuoi ruoli",
    button: "Accetta l'invito",
    expires: "Questo invito scade il {date}.",
    fallback: "Se il pulsante non funziona, copia e incolla questo link nel browser:",
    ignore: "Non te lo aspettavi? Puoi ignorare questa e-mail: non succede nulla finché non accetti.",
    sentBy: "Inviato da {brand}",
    help: "Domande? Scrivi a {support}.",
  },
};

/** `es-MX` → `es`, `PT_br` → `pt`; anything unsupported falls back to the default. */
export function resolveLocale(requested: string | undefined, fallback: EmailLocale = DEFAULT_LOCALE): EmailLocale {
  const language = requested?.trim().toLowerCase().split(/[-_]/)[0];
  return language && language in STRINGS ? (language as EmailLocale) : fallback;
}
