# ADR-0024: Cicle de vida de l'enviament (immediat, retingut, programat) i ajornats

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12. Cobreix la porta de #89 sobre el
  contracte durador.
- Data: 2026-10-12.
- Abast: #89.

## Context

L'enviament programat ja era durador (`scheduled_sends` més els intents de
#29). El període per a desfer, en canvi, només vivia en un temporitzador de
la interfície: tancar l'aplicació o una fallada en aquells segons perdia la resposta.
A més:
- un «Enviar ara» simultani amb el vigilant podia donar per enviat, i
  suprimir, un missatge el primer intent del qual encara era en curs;
- la interfície no deia que l'aplicació ha d'estar oberta;
- un fil ajornat que es movia desapareixia de tot arreu.

## Decisió

- **Un sol camí durador:**
  - una resposta en el seu període per a desfer es desa també com a enviament
    programat, amb el seu Message-ID com a id;
  - venç al final del període més un marge de 120 s;
  - deixar-la anar o desfer-la en suprimeix abans aquesta còpia;
  - si l'aplicació es tanca o falla, la còpia surt quan es torna a obrir;
  - la còpia i la resposta comparteixen id d'intent, de manera que el nucli mai
    no envia totes dues.
- **Transicions:**
  - retingut → (desfer: suprimit) | (venç: còpia suprimida → enviant);
  - programat → enviant → acceptat | arxivat | rebutjat (es reintenta
    amb espera creixent, fins a 5 vegades) | incert (mai no es reintenta sol);
  - un intent «enviant» amb l'aplicació en marxa és en curs: qui el
    va començar el tanca, i ningú més no en suprimeix la fila;
  - en arrencar, el que ha quedat «enviant» passa a incert abans que comenci
    el vigilant.
- **Desfer no és recuperar:**
  - només existeix abans que el missatge surti;
  - si la còpia desada no es pot suprimir, es diu que encara pot sortir.
- **Hora i rellotge:**
  - les hores es desen en segons UTC; «demà a les 8» es calcula en
    l'hora local, de manera que el canvi d'horari no la mou;
  - un enviament que surt més de 5 minuts tard ho diu;
  - el menú avisa que cal tenir l'aplicació oberta.
- **Secrets:** la contrasenya d'una clau mai no es desa amb un missatge
  programat.
- **Ajornats:**
  - es desen per conversa;
  - si la conversa es mou, es troben a la seva carpeta actual;
  - una clau feta d'un uid no es cerca en una altra carpeta, perquè allà aquell
    uid és un altre missatge;
  - en despertar no es promet «de tornada a la safata d'entrada»: mai no
    s'ha mogut.

## Pendent

- Que una resposta nova desperti abans una conversa ajornada.
- Un període per a desfer també a l'editor complet, que avui envia al
  moment.
