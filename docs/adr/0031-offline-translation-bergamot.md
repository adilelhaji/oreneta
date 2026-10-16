# ADR-0031: Traducció sense connexió amb Bergamot

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Dins de l'ADR-0001; sense
  telemetria nova ni servei nou de pagament.
- Data: 2026-10-12.
- Abast: #106.

## Decisió

- **Motor:**
  - Bergamot (`@browsermt/bergamot-translator` 0.4.9, MPL-2.0), el que ja
    triava l'ADR-0001;
  - el seu worker i el seu WebAssembly (5 MB) van amb l'aplicació, a
    `/bergamot/`, i es carreguen la primera vegada que es tradueix;
  - la política de seguretat ja permet WebAssembly (ADR-0030); el worker se
    serveix des de la mateixa aplicació.
- **Models:**
  - els de Mozilla (MPL-2.0), publicats per a Bergamot 0.3.3 a
    `storage.googleapis.com/bergamot-models-sandbox`;
  - l'aplicació no els demana a aquest bucket, que Mozilla anomena «sandbox» i
    pot retirar: els demana a una còpia sense canvis al release
    `translation-models-0.3.3` d'aquest repositori (revisió del
    propietari, 2026-10-12). La còpia la fa a mà el workflow
    *Publish translation models* amb `scripts/translation-models/mirror.py`,
    que comprova cada fitxer contra el registre abans de pujar-lo. Un
    release només té una llista plana, i alguns noms es repeteixen entre
    parells, de manera que cada fitxer es publica com a `<par>-<nombre>`. El release
    mai no es marca com el darrer, perquè l'actualitzador no el vegi;
  - el registre amb el nom, la mida i l'SHA-256 de cada fitxer va
    amb l'aplicació (`meron-core/src/translation/registry.json`): no es
    baixa cap llista, i no es pot demanar res que no hi sigui;
  - només els models que Firefox va publicar com de qualitat de producció:
    anglès amb búlgar, txec, alemany, espanyol, estonià, francès, italià,
    polonès i portuguès en els dos sentits, i noruec (bokmål) a anglès;
  - entre dos idiomes que no són l'anglès es tradueix passant per l'anglès, amb
    dos models;
  - no hi ha model de català ni d'altres idiomes: es diu «no hi ha model».
- **Baixada:**
  - només quan la persona la demana, després de veure quins idiomes, quant
    ocupa i des d'on;
  - la fa el nucli, amb el servidor intermediari (proxy) de l'aplicació, a una carpeta
    provisional; cada fitxer es comprova (mida i SHA-256) i només
    llavors la carpeta passa al seu lloc;
  - un fitxer més llarg del que s'ha publicat es talla tan aviat com se supera;
  - cancel·lar, un tall de xarxa o tancar l'aplicació no deixen res que
    sembli instal·lat; en arrencar se suprimeix el que va quedar a mitges;
  - els models ocupen com a màxim 1 GiB en total (tots junts són uns
    425 MB); si el disc s'omple, es diu i no es desa res;
  - els models són de la instal·lació, no d'un perfil.
- **Ús:**
  - el pont Go serveix els models instal·lats a `/models/`, mai una
    carpeta a mig baixar;
  - l'aplicació torna a comprovar l'SHA-256 de cada fitxer abans de
    carregar-lo;
  - traduir no fa servir la xarxa.
- **Llegir:**
  - «Traduir…» al menú d'un missatge pregunta de quin idioma a quin, amb
    una suposició (paraules freqüents de cada idioma) que es pot
    canviar;
  - la traducció es mostra en lloc del text, marcada com a traducció
    automàtica feta en aquest equip, amb «Veure l'original»; el missatge no
    canvia;
  - l'HTML traduït es mostra en el mateix marc aïllat que l'original.
- **Escriure:**
  - «Traduir aquest missatge» mostra la traducció per a revisar-la sense tocar
    l'esborrany;
  - després, «Afegir a sota» conserva el que s'ha escrit, i «Fer servir en lloc del que
    s'ha escrit» ho substitueix amb opció de desfer.
- **Límits:** més de 100 000 caràcters no es tradueixen d'una vegada; aturar
  acaba el worker i la traducció a mitges.

## Alternatives

- Baixar del bucket de Mozilla (la decisió inicial): sense res a
  mantenir, però depèn d'un bucket de proves que pot desaparèixer.

- Serveis en línia (DeepL, Google): el text surt de l'equip.
- Models més nous de Mozilla (`moz-fx-translations-data`): més idiomes,
  però fets per al Bergamot de Firefox, no per al paquet publicat, i
  sense un registre estable de resums (hash).
- Remote Settings de Firefox: un servei de Mozilla pensat per a Firefox;
  afegiria una dependència de xarxa que no cal.

## Pendent

- Detectar l'idioma amb un model (CLD) en lloc de paraules freqüents.
- Deixar que la persona canviï el límit d'espai.
- Traduir dins de la previsualització del lector sense obrir el missatge.
