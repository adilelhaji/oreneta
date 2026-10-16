# ADR 0009: Preferències de visualització de la bústia

Estat: Acceptada — 2026-10-05. L'usuari va aprovar "Aprobar vista general y
excepciones por carpeta" a la conversa d'implementació de #36, després de revisar
el [contracte concret](../design/mailbox-view-preferences-proposal.md).

Es fa servir una única preferència versionada `mailbox_views` pel camí de configuració existent.
Una disposició global de columnes s'hereta tret que un parell exacte de compte i carpeta tingui una
substitució explícita i independent. Restablir una carpeta n'elimina la substitució; canviar
la disposició global no sobreescriu les carpetes personalitzades. Sense cap base de dades, servei
remot ni mecanisme de sincronització nous.

Inicialment s'exposen remitent, assumpte, data i compte. L'assumpte continua visible;
els controls de selecció queden fora de la disposició. Només s'ordena per remitent/assumpte/data, amb
l'ordenació de tot el resultat de l'ADR 0003. El compte només es mostra. Les metadades no compatibles
i les noves capacitats d'ordenació queden fora d'aquesta decisió.

Abans d'utilitzar-los, es validen la versió, els identificadors, les columnes duplicades i les amplades. Es preserven
les versions futures desconegudes sense escriptures silencioses. Els usuaris existents sense aquesta
preferència conserven la disposició compacta actual. Calen la configuració per teclat, el desplaçament
horitzontal acotat, el restabliment explícit i les proves de reinici i d'aïllament entre comptes.
El document del contracte defineix els valors per defecte i els límits detallats.

La implementació avança en incidències acotades i revisades, amb la CI en verd. L'aprovació no
autoritza publicacions, canvis de proveïdor ni afirmacions de paritat completa.
