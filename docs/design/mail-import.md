# Importació de correu a l'arxiu local (#112, ADR-0014)

## Ús

**Configuració → Còpia de seguretat → Importa correu**:
1. Es trien un o diversos `.eml` o `.mbox`.
2. Una previsualització indica quants missatges s'importaran, quants ja són
   a la carpeta i quants no són correu o superen la mida màxima. També
   permet triar la carpeta de l'arxiu.
3. En confirmar, s'importen.

La primera vegada apareix el compte **Arxiu local** a la barra lateral. Es
llegeix, s'hi cerca, es mou i s'esborra com qualsevol altre, però no pot enviar
i no figura entre els remitents.

## Des d'Outlook (PST)

Oreneta no llegeix fitxers `.pst` ni `.ost` directament: no existeix cap lector en
Rust madur i mantingut, i el propietari va decidir (2026-10-12) no escriure'n cap
i documentar la conversió. `readpst` (libpst, GPL) converteix el fitxer a
MBOX i el resultat s'importa amb el que ja existeix.

1. **Instal·lar `readpst`.**
   - Linux: el paquet `pst-utils` (Debian/Ubuntu: `sudo apt install pst-utils`;
     Fedora: `sudo dnf install libpst`).
   - macOS: `brew install libpst`.
   - Windows: dins de WSL, com a Linux.
2. **Convertir** (amb Outlook tancat, sobre una còpia del fitxer):

   ```sh
   readpst -8 -o sortida/ "Outlook.pst"
   ```

   - Es crea un `.mbox` per carpeta: `Inbox.mbox`, `Sent Items.mbox`...
   - `-8` escriu els cossos en UTF-8 quan Outlook n'ha desat aquesta versió.
   - Els elements esborrats d'Outlook no s'inclouen; `-D` els afegeix.
   - Un `.pst` protegit amb contrasenya es llegeix igualment: la contrasenya de
     PST no xifra el contingut.
3. **Importar** d'una d'aquestes dues maneres:
   - **Carpeta a carpeta**: *Configuració → Còpia de seguretat → Importa
     correu*, triar un `.mbox` i indicar la carpeta de l'arxiu (per
     exemple `Outlook/Safata d'entrada`). Així cada carpeta queda amb el
     nom que es triï.
   - **Tot de cop**: *Importa des de Thunderbird → Tria una carpeta* i
     triar `sortida/`. Cada `.mbox` s'ofereix com una carpeta; es marquen
     les que es vulguin. La carpeta conserva el nom del fitxer, amb
     `.mbox` al final, i es pot reanomenar després.

Importar dues vegades no duplica: els missatges que ja hi són se salten.

El calendari i els contactes surten en fitxers a part, que l'importador de correu
no pren per missatges:
- `Calendar.calendar` és iCalendar: reanomenat a `.ics`, s'importa des de
  Calendari (*Importa ICS*).
- Amb `-cv`, `Contacts.contacts` és vCard: reanomenat a `.vcf`, s'importa
  des de Contactes. Sense `-cv` és una llista d'adreces.

Provat amb `readpst` 0.6.76 i els fitxers de prova públics de
java-libpst (`example-2013.ost`, `dist-list.pst`): una carpeta per `.mbox`,
separadors `From "adreça" data` que l'importador reconeix
(`archive/tests.rs`).

## Exportació (#112)

El menú d'accions de la llista (⋮) ofereix **Exporta la carpeta com a .mbox** a
qualsevol carpeta d'un compte IMAP o de l'arxiu local. El nucli escriu els
missatges originals en format mboxrd (cada línia `>*From ` guanya un `>`) per
lots de 50, en un `.part` al costat de la destinació que només es reanomena en
acabar: una fallada a mitges no deixa cap fitxer truncat amb el nom triat. El que
s'exporta es torna a importar igual (prova d'anada i tornada).

Graph i Exchange no lliuren el missatge original, de manera que allà no s'ofereix;
desar un sol missatge com a `.eml` ja existia.

## Proves

| Nivell | Què cobreix |
|---|---|
| N1 (`archive/tests.rs`) | Divisió de MBOX amb LF i CRLF i desfer `>From`; importació amb fils i cossos sense servidor; duplicats; moure, copiar i esborrar conservant els bytes; paperera; corpus difícil (encoded-words, Latin-1 sense charset, capçaleres plegades, adjunt truncat, LF, sense Message-ID, PDF reanomenat, fitxer buit) |
| N1 distribuïdor (`main.rs`) | Una previsualització no crea res; importar dues vegades no duplica; l'arxiu no demana reconnexió; carpetes, lectura del fil i esborrat a la paperera amb les ordres normals de correu |
| N2 (`MailImportDialog.test.tsx`) | Previsualització, canvi de carpeta, confirmació i avís; l'arxiu no s'ofereix mai com a remitent |
| N1 exportació (`archive/tests.rs`, `main.rs`) | mboxrd amb LF, CRLF, `From ` i `>From` al cos es rellegeix igual; exportar la carpeta o només els triats; una destinació impossible no deixa cap `.part` |
| N2 exportació (`ExportFolder.test.tsx`, `mailCapabilities.test.ts`) | L'element només apareix on es pot; cancel·lar no avisa; es comunica una fallada; Graph, Exchange i RSS no exporten |
| N1 PST (`archive/tests.rs`) | La sortida de `readpst` (separador `From "adreça"`, `>From` al cos) es divideix en els seus missatges |
| Protecció ADR-0011 | `archive_messages` s'esborra amb el compte |
