# WHATSAPP-ADDRESS-GUARD-HARDENING-51 — Report

**Data:** 2026-06-05
**Branch:** `whatsapp/address-guard-hardening-51` (base `origin/main` = `3ed7eb4`)
**Scope:** solo backend locale + test offline. No deploy, no DB reale, no migration, no frontend.

## 1. Problema
La guardia deterministica `isDireccionConcretaParaDelivery`
(`src/utils/addressGuard.js`) decide se una `direccion` libera estratta da
WhatsApp è abbastanza concreta da geocodare e mandare in **delivery
automatico**. Se è troppo permissiva, il bot rischia di accettare un indirizzo
ambiguo e mandare il rider nel posto sbagliato / contaminare `geo_cache`.

## 2. Vecchio limite (documentato in OFFLINE-SAFETY-GAPS-TESTS-48)
La vecchia logica accettava un indirizzo come "concreto" quando c'era una
cifra e la frase aveva **più di 3 token**, anche senza un ancoraggio via.
Esempio noto:

- `hotel sol y playa 5` → **passava** (≥4 token + cifra), pur essendo vago.

Inoltre accettava un prefisso via **senza numero** (`Calle Mayor` → ok).

## 3. Nuova regola (più prudente)
Per passare in automatico ora serve **un ancoraggio via esplicito + numero
civico**. In dubbio si preferisce il **falso negativo** (→ operatore/Preguntas).

Ordine di valutazione:
1. **Frasi vaghe** (`cerca de…`, `al lado de…`, `junto a…`, `enfrente de…`,
   `detrás de…`, `por la zona`, …) → BLOCCATE sempre, anche con cifra/via.
2. **Riferimenti personali** (`mi casa`, `mi piso`, …) → BLOCCATE.
3. **Prefisso via + numero** (`calle/c\//avenida/av./paseo/plaza/carretera/
   camino/ronda/urbanización/…` + cifra) → **OK**. Le parole-POI
   (`playa`, `portal`, `piso`) sono tollerate qui perché la via àncora
   l'indirizzo (es. `Calle Real 8, portal 2`, `Avenida Playa Serena 12`).
4. **Prefisso via senza numero** (`calle`, `avenida sin numero`) → BLOCCATA
   (`sin_numero`).
5. **POI/località senza prefisso via** (`hotel`, `playa`, `puerto`, `bloque`,
   `portal`, `piso`, `marina`, `evershine`, `roquetas`, `mercadona`, …),
   con o senza cifra → BLOCCATA (`poi_sin_via`).
6. **Numero senza via chiara**: si accetta SOLO il classico
   `Nombre Apellido <numero>` spagnolo (token numero civico + ≥2 parole-nome +
   frase corta ≤4 token). Altrimenti (`5`, `Q5`, frase lunga con una cifra) →
   BLOCCATA (`numero_sin_via_clara`).
7. Né via né numero né POI → `sin_via_y_numero`.

Nessuna modifica all'orchestrator: usa già `guard.ok`/`guard.motivo` e in caso
`!ok` instrada a `IN_TRATTAMENTO` con `MSG_DIRECCION_VAGA` (operatore).

## 4. Positivi / Negativi testati
**Positivi (→ ok):** `Avenida Carlos III 50`, `Calle Anade 35`, `Av. Sabinar 12`,
`Plaza Mayor 4`, `Calle Real 8, portal 2`, `Paseo del Mar 15`, `Calle X 10 piso 2`,
`Calle Cuba 5`, `C/ Cuba 5, 3A`, `Avenida Playa Serena 12`, `Av. España 250`,
`Urbanización Las Marinas, 4`, `Antonio Machado 69`.

**Negativi (→ operatore):** `hotel sol y playa 5`, `hotel sol y playa`,
`en el hotel`, `playa serena`, `playa serena 5`, `cerca del puerto 7`,
`al lado del mercadona 3`, `bloque 5`, `portal 3`, `piso 2`, `roquetas`,
`roquetas 12`, `la marina`, `marina 4`, `evershine`, `evershine 7`, `5`, `Q5`,
`calle`, `avenida sin numero`, `Calle Mayor` (no numero), `Aguadulce`,
`Roquetas de Mar`.

Risultato: `tests/addressGuard.test.js` → **63 passed, 0 failed**.

## 5. Rischi
- **Falso negativo intenzionale:** indirizzi reali senza prefisso via e con
  formato non `Nombre Apellido <num>` (o frasi lunghe con una cifra) ora vanno
  a operatore invece che in automatico. È la prudenza voluta: meglio chiedere
  conferma che mandare il rider nel posto sbagliato.
- `Calle Mayor` (via senza numero) ora richiede il numero: comportamento
  cambiato di proposito (prima passava).
- Mitigazione: l'operatore può sempre forzare manualmente (`zona_manuale`).

## 6. Conferme
- **No deploy.** No push su main. **No DB reale.** No migration. No
  `geo_cache`. No frontend. No CommitWriter. No PII/secrets nei file.
- Funzione **pura** (nessun DB/rete); i test usano solo fixture fake.
