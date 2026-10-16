# Acceptació d'IMAP IDLE (#121)

`watch.start` confirma la planificació, no que estigui a punt. La seva posada al dia
asíncrona emet `mail.synced` fins i tot per a una carpeta vigilada buida. L'acceptació
d'integració captura el recompte d'esdeveniments abans d'iniciar-se i espera aquest
esdeveniment inicial abans d'afegir el missatge sintètic. Cada espera d'esdeveniment té
un termini de 60 segons.

L'enviament (push) posterior ha d'emetre un altre esdeveniment i posar el missatge
concret a la memòria cau; l'asserció fa servir `messages.recent(refresh:false)`, mai una
actualització manual. Les assercions existents d'aturada del vigilant i d'absència de
més enviaments no canvien. La CI executa la suite completa amb el sidecar real/Maddy i
repeteix el cas IDLE tres vegades.

Això elimina una condició de carrera de l'esdeveniment inicial observada al PR #120, execució 34326510250, intent 1.
No canvia la implementació del vigilant ni certifica proveïdors externs.
