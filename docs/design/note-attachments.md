# Fitxers a les notes (#104, ADR-0042)

## Ús

A sota del text d'una nota, **Adjunta un fitxer…** desa una còpia del fitxer
triat. Cada fitxer mostra el nom i la mida, amb **Desa** i **Treu**; treure'l
pregunta abans. A la paperera, els fitxers es poden desar però no canviar.

## Nucli

- `meron-core/src/store/note_attachments.rs`.
- Ordres: `notes.attachments`, `notes.attach`, `notes.removeAttachment` i
  `notes.saveAttachment`.
- El pont hi afegeix `notes.pickAttachment` i `notes.saveAttachmentAs`, que
  obren els diàlegs del sistema.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`note_attachments.rs`) | Fitxer desat sencer amb el seu nom i retornat igual; canviar l'original no canvia la còpia; cap `.part` en acabar; massa gran, inexistent, una carpeta o una nota inexistent es rebutgen sense desar res; es conserven a la paperera, no s'afegeixen a una nota que és a la paperera i desapareixen en suprimir-la definitivament; un desament fallit no deixa cap fitxer parcial; treure només una vegada |
| N2 (`NoteAttachments.test.tsx`) | Llista, adjuntar el triat, desar pel seu nom, treure pregunta abans, a la paperera només desar |
| N4 pendent | Diàlegs del sistema a Windows |
