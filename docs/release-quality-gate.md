# Porta de qualitat de publicació

Els fluxos de treball (workflows) de publicació d'escriptori i d'Android depenen de
`verify-release.yml` abans de compilar o de llegir els secrets de signatura. La porta és
de només lectura i requereix que l'última execució **push a main** de `test.yml` per al
commit exacte de la publicació hagi acabat correctament. Les set suites (`go`, `go-windows`, `rust`, `frontend`, `mobile`, `integration`
i `workflow-policy`) han d'estar presents i haver acabat correctament; els jobs omesos,
absents, cancel·lats, fallits i pendents bloquegen la publicació. No n'hi ha prou amb una
execució verda d'un PR ni amb una execució verda d'un altre commit. La porta també es tanca en cas
d'error d'API o de permisos (fail closed).

Les etiquetes de git de publicació existents s'han de resoldre en aquest mateix commit (les
etiquetes de git anotades es desreferencien). Les etiquetes de git d'escriptori han de coincidir amb la
versió de producte de `wails.json`. Una execució manual d'escriptori pot crear una
etiqueta de git de versió que falti; la publicació fa servir el SHA validat com a
`target_commitish`, mai la punta mòbil de la branca per defecte. Les compilacions
manuals d'Android sense etiqueta de git només generen artefactes i continuen requerint la CI
sobre el SHA seleccionat.

## Procediment de l'operador

1. Fusioneu els canvis de la publicació i espereu totes les suites de `test.yml` a `main`.
2. Seleccioneu aquest commit exacte per a una etiqueta de git de publicació coincident o per a una execució manual de publicació.
3. Comproveu el resum **Release commit verified** per veure'n el SHA i l'enllaç a l'execució de CI.
4. Si la porta falla perquè la CI encara s'està executant, espereu que acabi aquesta
   execució de CI i torneu a executar el flux de treball de publicació. No eludiu la porta
   ni feu servir un SHA verd diferent.

Afegir aquesta política o executar-ne les proves no desencadena cap publicació. Les
proves unitàries fan servir respostes de GitHub simulades i s'executen sense credencials
ni secrets de signatura:

```sh
node --test scripts/ci/*.test.cjs
```

## Abast i feina pendent

Això implementa #57, una part de #26. És una comprovació de seguretat del flux de
treball, **no** un substitut de les branques i etiquetes de git protegides: qui tingui
autorització per canviar els fluxos de treball pot canviar aquesta política. Durant la
implementació, la integració de GitHub va retornar HTTP 403 per a l'administració de la
protecció de branques. Un administrador ha de configurar per separat les comprovacions
obligatòries i protegir les etiquetes de git de publicació. La comprovació més àmplia de format
i l'anàlisi estàtica, la cobertura dels camins modificats i la procedència de la cadena
d'eines continuen pendents a #26.

La política s'aplica als commits que contenen aquests fluxos de treball. Les etiquetes de git
històriques amb commits anteriors a la porta no adquireixen retroactivament el nou flux
de treball. No llanceu publicacions des d'aquestes revisions històriques.

Referències de l'API: [execucions de fluxos de treball](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)
i [github-script](https://github.com/actions/github-script).
