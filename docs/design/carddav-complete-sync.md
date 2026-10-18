# Sincronització CardDAV completa o res (#28)

## Problema reproduït

`fetch_book` retornava el que podia llegir: una targeta amb un `GET` fallit
s'ometia, una resposta `REPORT` sense `address-data` s'ignorava i un XML tallat
a mitges s'analitzava fins on arribés. El codi que el cridava substituïa la
llibreta local per aquest resultat (`replace_book`), de manera que un error
parcial esborrava contactes en silenci mentre la sincronització constava com a
correcta (H02). Hi havia una prova que fixava aquest comportament com a
desitjat.

## Contracte

- **Tot o res.** Llegir una llibreta retorna la llibreta sencera o un error que
  indica quantes targetes hi han faltat i quina és la primera. Amb error, el
  codi que el crida no toca la còpia local i desa el motiu a `lastError`, que
  Configuració > Contactes ja mostra en vermell.
- **Què compta com a incomplet:** resposta de targeta sense `address-data` o
  amb un estat d'error (inclòs un `propstat` fallit seguit d'un altre de
  correcte), `address-data` que no és una vCard, `GET` de targeta amb estat
  ≥ 300, llistat `PROPFIND` amb estat ≥ 300, i qualsevol `multistatus` mal
  format o sense tancament (`parse_multistatus_complete`).
- **Llibreta buida vàlida:** un `multistatus` complet sense targetes és un èxit
  buit, sense segona sol·licitud.
- **Supressions reals:** un contacte suprimit al servidor desapareix a la
  sincronització completa següent; la política no congela la llibreta.

## Credencials

Cada sol·licitud porta la contrasenya, de manera que seguir un `href` del
servidor equival a lliurar-la allà on apunti.

- `credentials_may_follow`: mai d'HTTPS a HTTP; a un altre amfitrió només per
  HTTPS (proveïdors que reparteixen DAV entre amfitrions, com les particions
  d'iCloud); un servidor HTTP local només conserva el seu propi origen.
- En el descobriment, un `href` de principal o de home-set que no compleix
  aquesta regla compta com a pas sense resultat i se n'indica el motiu; no
  s'ofereix una llibreta en un origen no permès.
- En llegir una llibreta, les targetes només es demanen al mateix origen de la
  llibreta. Un `href` a un altre servidor atura la lectura sense enviar-hi res.
- `UreqTransport` fixa `RedirectAuthHeaders::Never`: la contrasenya no es
  reenvia mai en una redirecció (era el valor per defecte d'ureq; ara és
  explícit).

## Cost acceptat

Una targeta trencada de manera permanent al servidor impedeix actualitzar
aquella llibreta fins que es corregeixi. L'error indica quina és. És preferible
a perdre contactes sense avís; una fusió per element amb les targetes fallides
preservades seria una millora posterior, no necessària per als criteris de #28.

## Verificació

- Rust (`carddav::client_tests`): targeta que no arriba, targeta amb estat 500,
  `propstat` 403 seguit de 200, XML tallat, vCard no vàlida, llibreta buida
  sense segona sol·licitud, la llibreta que es llista a si mateixa, targeta en
  un altre amfitrió sense cap sol·licitud enviada, regles d'origen i
  descobriment sense passar d'HTTPS a HTTP.
- Integració amb Radicale (`TestIntegrationContacts`): descobriment, lectura,
  canvi, supressió real recollida, contrasenya rebutjada i servidor caigut amb
  els contactes conservats.
- No cobert: redireccions reals entre orígens contra un servidor (la regla
  d'ureq es fixa en el codi, no es prova amb xarxa) i proveïdors reals.
