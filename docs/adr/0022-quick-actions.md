# ADR-0022: Accions ràpides

- Estat: acceptada; presa per delegació i revisada pel propietari
  el 2026-10-12.
- Data: 2026-10-11.
- Abast: primer lliurament de #92.

## Context

#92 demana encadenar accions sobre les converses seleccionades amb un
sol gest. Una cadena que envia, reenvia o suprimeix pot fer un mal que no es
desfà, i una que s'executa sobre una selecció que canvia mentre s'executa
pot tocar missatges que ningú no ha triat.

## Decisió

- **Passos permesos:** marcar com a llegit o no llegit, destacar o treure el
  destacat, arxivar i moure a una carpeta. Res d'enviar, reenviar,
  respondre, suprimir ni cridar una altra acció ràpida.
- **Arxivar o moure va al final:** després de moure, la conversa ja no
  és on els passos següents la buscarien. L'editor rebutja una cadena
  que ho incompleix, i el mateix fa la càrrega dels paràmetres.
- **Límits:** fins a 8 passos per acció i 9 accions (Alt+1 … Alt+9).
- **Confirmació i conjunt fix:** executar demana confirmació i fixa en aquell
  moment les converses afectades. El que entri a la selecció o en surti
  després no canvia el que es fa.
- **Cadena per conversa:** cada conversa recorre els passos en ordre i
  s'atura en el primer que falla; les altres continuen. En acabar, es
  mostra un informe pas a pas per conversa, amb les fallades a dalt.
- **Emmagatzematge:** les accions viuen als paràmetres (`quick_actions`) i
  se sanegen en carregar-se: el que no compleix les regles es descarta.

## Pendent

- Etiquetes i categories com a passos, quan #91 i #95 en fixin el contracte.
- Executar sobre la conversa oberta sense selecció explícita.
