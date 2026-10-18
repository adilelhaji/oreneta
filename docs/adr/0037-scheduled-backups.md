# ADR-0037: Còpies programades del perfil

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: #173, sobre l'ADR-0010 i l'ADR-0017.

## Decisió

- **Qui programa:** el nucli, mentre l'aplicació és oberta.
  Oreneta no instal·la cap tasca al sistema. Una còpia que tocava amb
  l'aplicació tancada es fa una sola vegada, poc després d'obrir-la (no en
  arrencar, per a no alentir-lo).
- **Desactivada per defecte.** Activar-la demana:
  - una carpeta que existeixi i que no sigui dins del perfil ni el contingui;
  - una contrasenya d'almenys 8 caràcters, confirmada.

  La contrasenya es desa al clauer del sistema i mai no torna a la
  interfície. Si el clauer no la conserva, la còpia programada falla amb
  «falta la contrasenya» i s'avisa; no es fa sense ella.
- **Què compta com a còpia:** la còpia completa de #171, escrita al costat de la
  destinació i canviada de nom en acabar. Després s'obre sencera en una carpeta
  privada, com fa «Comprovar». Només compta una còpia que passa aquesta
  comprovació. Si no la passa, se suprimeix (és seva) i s'informa.
- **Retenció:**
  - es conserven N còpies comprovades (d'1 a 30, 7 per defecte);
  - opcionalment, un límit d'espai;
  - la còpia comprovada més recent no se suprimeix mai, encara que superi el
    límit per si sola o fallin les còpies següents.
- **Què pot suprimir:** només fitxers que ha escrit i comprovat, amb el seu
  prefix `oreneta-scheduled-` i amb la mateixa mida que tenien en
  escriure'ls. Un fitxer canviat s'oblida, no se suprimeix. No es toca res més de la
  carpeta.
- **Concurrència:** una còpia manual i una de programada mai no s'escriuen
  alhora; la segona es rebutja amb un missatge, o espera la comprovació
  següent si és la programada.
- **Fallades:**
  - una fallada (disc ple, carpeta absent, contrasenya absent) deixa les
    còpies anteriors com estaven;
  - es reintenta una hora després, no en bucle;
  - s'avisa encara que Paràmetres estigui tancat.
- **Restaurar:** un perfil restaurat arriba amb les còpies programades
  desactivades. La seva contrasenya no és a l'arxiu, i la seva carpeta pot ser
  d'un altre equip.

## Alternatives descartades

- **Tasca del sistema (Programador de tasques, launchd, systemd):** faria
  còpies amb l'aplicació tancada, però exigeix instal·lar alguna cosa fora de
  l'aplicació, a cada plataforma. Queda per a quan hi hagi instal·lador
  signat.
- **Copiar al núvol:** fora d'abast de #173, sense despesa ni servei.
- **Desar la contrasenya a la base:** la còpia del perfil la portaria
  a dins.
