# ADR-0042: Fitxers adjunts a les notes

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-12.
- Abast: #104, sobre ADR-0015.

## Decisió

- **On es desen:** dins de la base de dades del perfil, al costat de la nota
  (`note_attachments`, esquema 57).
  - La còpia completa del perfil (ADR-0017) els inclou sense més; la memòria
    cau d'adjunts del correu, en canvi, queda fora d'aquesta còpia.
  - No cal tornar a trobar res de fora del perfil.
- **Què es desa:** una còpia del fitxer triat, fins a 25 MB per fitxer
  i 50 per nota. El fitxer original no es torna a tocar. Un de més gran es
  rebutja amb la indicació d'enllaçar-lo.
- **Desar una còpia:**
  - s'escriu al costat de la destinació i es reanomena en acabar;
  - si alguna cosa falla, no queda un fitxer tallat amb el nom triat;
  - el nom es redueix a un nom de fitxer, sense carpetes.
- **Paperera:**
  - mentre la nota és a la paperera, els seus fitxers es conserven i es
    poden desar, però no afegir ni treure;
  - en suprimir la nota definitivament, o al cap de 30 dies, se'n van amb ella.
- **Treure un fitxer** pregunta abans i deixa intacte l'original.

## Alternatives descartades

- **Desar-los a la carpeta multimèdia:** aquesta carpeta és memòria cau i la
  còpia del perfil no la inclou, de manera que els adjunts es perdrien en
  restaurar.
- **Inserir-los a l'HTML de la nota:** inflaria el text, que té un
  límit de 8 MB i es cerca sencer.
