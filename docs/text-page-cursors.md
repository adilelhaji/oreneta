# Paginació per claus de text (#65)

`get_recent_page_sorted` genera un cursor a partir de la clau exacta que retorna la seva
consulta SQL. No ha de reconstruir aquesta clau a partir dels camps de remitent/assumpte
mostrats: `lower()` de SQLite i la conversió a minúscules Unicode de Rust difereixen, i
retallar els espais d'un remitent abans de crear el cursor canvia la clau sense canviar
l'ordenació SQL.

Mantingueu l'expressió SQL existent, el valor alternatiu del remitent, la direcció, el
desempat per UID i la codificació de cursor `date:`/`sortk:`. La clau addicional
seleccionada és interna; la càrrega útil i l'esquema dels missatges no canvien. Això
corregeix els cursors generats a partir d'ara; les claus incorrectes ja emeses
requereixen tornar a carregar la primera pàgina.

Les proves de regressió comparen el recorregut complet d'un conjunt de dades estable amb
la consulta sense paginar per a cada clau/direcció i per a mides de pàgina 1, 2 i 3.
Incloeu noms/assumptes repetits/buits, només d'espais/amb farciment i no ASCII. Això
valida els conjunts de claus per missatge, no l'ordenació per converses agrupades ni
l'ordenació unificada; #30 continua oberta.

Les proves de Rust s'executen a la CI (l'amfitrió de validació de Windows actual no té la cadena d'eines de Rust).
