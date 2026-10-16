# Contracte d'autorització de Graph (#127)

Implementa l'ADR-0004 acceptat; cap canvi a l'OAuth existent d'Outlook/Gmail.

- El Go d'escriptori només és responsable de l'escoltador de bucle local (loopback) efímer i de l'obertura del navegador.
  Rust és responsable de PKCE/state/nonce, l'intercanvi/renovació de testimonis, la verificació d'identitat i
  l'emmagatzematge de credencials. Cap testimoni bearer/d'actualització ni codi d'autorització no es retorna
  a l'estat del frontend, als registres ni a les preferències.
- Un flux dura deu minuts, està vinculat al compte local seleccionat (si n'hi ha),
  i consumeix una única crida de retorn vàlida. La cancel·lació/substitució invalida la
  generació; un intercanvi tardà no es pot confirmar. Les crides de retorn amb un state erroni no poden
  consumir una petició pendent legítima.
- Només hi pot haver un flux de compte nou no associat pendent. La desconnexió també cancel·la
  els fluxos no associats: la seva identitat encara no es coneix, de manera que cap no pot recrear
  la concessió suprimida després que s'hagi completat el seu intercanvi de testimonis.
- Demanar només `openid email profile offline_access` i el `Mail.Read` de Graph.
  Només punts finals (endpoints) globals de Microsoft v2. HTTPS, sense redireccions, servidor intermediari (proxy) per compte,
  resposta limitada i temps d'espera. Els errors exposen categories locals, no les descripcions del
  proveïdor. No es demana ni una contrasenya ni un secret d'aplicació.
- Validar RS256 amb el punt final JWKS v2 fix de Microsoft i `ring`; ignorar
  els URL de clau proporcionats pel testimoni. Validar l'emissor/tenant, l'audiència, la caducitat, el nonce i
  el parell immutable `(tenantId, objectId)`. Comprovar un `at_hash` opcional. La renovació fa servir
  el principal fixat; mai no s'ha de reinterpretar un testimoni d'Outlook com a testimoni de Graph.
- El correu electrònic serveix per a la visualització i l'associació local, no és la identitat de Microsoft. La primera associació
  a un compte existent requereix que l'adreça de la bústia seleccionada coincideixi amb
  l'adreça autenticada; els àlies ambigus fallen explícitament. La reconnexió ha de
  conservar el mateix parell tenant/objecte. No hi ha fusió automàtica d'àlies/tenants ni
  correspondència `/me` per a bústies compartides. La creació de comptes nous és responsabilitat de #128.
- Desar un registre versionat només de Graph (principal, associació local, ID de client,
  àmbits concedits, testimoni d'accés/d'actualització, caducitat) sota un espai de noms del clauer
  separat i amb resum (hash). La fragmentació i el xifratge existents del clauer es continuen fent servir. No se sobreescriu
  cap secret, configuració, etiqueta, esborrany ni memòria cau dels comptes de correu. Un emmagatzematge segur absent/desactivat
  falla explícitament; els registres mal formats mai no esdevenen concessions buides.
- Abans de desar una credencial de Graph, anotar al diari un marcador d'associació no secret als
  paràmetres de SQLite (`graph.grant.<hashed account>`). La supressió del compte invalida els
  fluxos pendents i suprimeix una concessió de Graph anotada al diari abans de suprimir les dades del
  compte; un emmagatzematge no disponible bloqueja la supressió d'aquesta concessió. Una escriptura de testimoni fallida
  pot deixar un marcador inofensiu, que se suprimeix després d'una supressió correcta del magatzem segur.
  Els comptes ordinaris sense marcador conserven el seu comportament de supressió existent.
- La supressió de comptes a l'escriptori i l'inici de l'autorització de Graph comparteixen un bloqueig asíncron
  del cicle de vida. El compte seleccionat es comprova mentre es manté el bloqueig; la supressió
  el manté fins que s'han suprimit el compte local i la memòria cau. Un inici en espera
  no pot recrear una associació a partir d'una comprovació obsoleta de l'existència del compte.
- La renovació es serialitza amb la desconnexió/reconnexió d'aquesta concessió. Persistir un
  testimoni d'actualització rotat abans d'informar de l'èxit; si no hi ha rotació, es conserva el
  testimoni actual. La reautenticació, el consentiment revocat i la fallada d'emmagatzematge conserven
  el registre anterior; cap reintent a cegues. La desconnexió local només suprimeix els secrets de Graph,
  no les altres sessions de Microsoft ni la concessió IMAP.
- L'èxit d'OAuth significa **autoritzat**, no un compte de correu actiu. #128 és responsable de la
  projecció i l'activació. Les proves no impliquen cap verificació amb proveïdors reals.

Validació: fixtures sintètiques de JWT/JWKS signats, d'OAuth i de clauer; caducitat,
discrepància d'àmbit/recurs/nonce/principal, cancel·lació/repetició, rotació de la renovació,
fallada d'emmagatzematge i respostes sense secrets. La CI obligatòria existent continua sent la porta de qualitat.
La fixture HTTP consumeix els cossos POST abans de tancar el sòcol per evitar que un
restabliment de Windows per petició no llegida emmascari la resposta d'error del proveïdor prevista.

Fonts comprovades el 2026-09-09:
[flux de codi de Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[declaracions del testimoni d'ID](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference),
[validació OIDC](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation).
