# Perfils (#99, ADR-0016)

## Ús

A **Configuració → Perfils** es creen, es reanomenen i s'obren perfils. Cadascun
té els seus propis comptes, correu, contactes, notes, preferències i
contrasenyes, i s'obre en una finestra pròpia; la finestra mostra el nom del
perfil. El perfil existent es diu «Perfil principal».

Un altre perfil es pot suprimir des d'aquí si no està obert. Si no s'ha obert
mai, n'hi ha prou de confirmar-ho. Si té dades, cal escriure'n el nom; el seu
nucli esborra abans les seves entrades del clauer i, si no pot, es pregunta
abans d'esborrar res (ADR-0038).

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 Rust (`secrets.rs`, `profile_purge.rs`) | El perfil per defecte conserva els noms del clauer; els altres porten el seu id i no coincideixen entre ells; la purga anomena cada tipus de secret, esborra els del perfil i cap altre, i avisa si apareix un lloc nou que desa secrets |
| N1 Go (`profiles_test.go`) | Argument i variable d'entorn; crear amb un id llegible i únic; nom buit o repetit rebutjat; reanomenar i títol de la finestra; camins, bloqueig i entorn del nucli propis del perfil, binari i actualitzacions compartits; un perfil desconegut o mal format obre el principal; una llista malmesa no es reescriu; un perfil sense dades se suprimeix sense escriure'n el nom; un amb dades, només amb el nom exacte, després de purgar-ne el clauer; un d'obert (amb el pany agafat) no se suprimeix; una purga fallida no esborra res tret que s'esculli; la purga s'executa amb l'entorn del perfil que se suprimeix; el nucli real purga un perfil amb nom i rebutja el principal; obrir llança un procés i no ho fa dues vegades; la pàgina rep el perfil i només canvia el document |
| N2 (`profile.test.ts`, `ProfilesGroup.test.tsx`) | Claus d'emmagatzematge per perfil; llista, obertura, creació amb avís de nom repetit; supressió amb el nom exacte i segona pregunta si la purga falla |
| N4 pendent | Dos perfils oberts alhora a Windows |
