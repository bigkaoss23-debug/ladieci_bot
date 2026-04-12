// ===============================================================
// config.js — La Dieci Pizzeria
// Costanti menu e informazioni ristorante
// ===============================================================

const MENU_LISTA = [
  // PIZZAS
  "1. El Pelusa - Margarita Clasica 12.00",
  "2. Zizou - Margarita de Bufala 12.50",
  "3. O Rei - Marinara Clasica 10.00",
  "4. Il Gladiatore - Caprichosa 14.50",
  "5. El Gaucho - Diavola 13.00",
  "6. El Divino Codino - Prosciutto 12.50",
  "7. La Pulga - Jamon y Champinones 13.00",
  "8. Il Tulipano Nero - Cuatro Quesos 14.50",
  "9. El Ultimo 10 - Atun y Cebolla 14.00",
  "10. El Mago de Zadar - Vegetariana 13.50",
  "11. El Maestro - Inferno 13.50",
  // POSTRES
  "Tiramisu Clasico 4.50", "Tiramisu Pistacho 5.50",
  "Tiramisu Nutella 5.50", "Tiramisu Lotus 5.50",
  "Pizza Nutella 7.00",
  "Tartufo Bianco 5.00", "Tartufo Nero 5.00",
  "Tartufo Pistacchio 5.00", "Tartufo Limoncello 5.00",
  // BEBIDAS
  "Estrella Galicia 3.00", "Heineken 3.00",
  "Peroni 4.00", "Refresco 2.50", "Agua 1.80"
];

const INFO_RISTORANTE =
  "RISTORANTE: La Dieci Pizzeria\n" +
  "INDIRIZZO: Plaza Italica 8, 04740 Roquetas de Mar (Almeria)\n" +
  "TELEFONO: 614 267 535\n" +
  "ORARI: Miercoles a Domingo 19:30 - 23:00\n" +
  "CERRADO: Lunes y Martes\n" +
  "SOLO RECOGIDA EN LOCAL (no reparto a domicilio)\n\n" +
  "PEDIDOS FUERA DE HORARIO: El bot esta activo 24h. Si alguien pide para un horario\n" +
  "antes de las 19:30, o un lunes o martes, responde con simpatia que el horno arranca\n" +
  "a las 19:30 de miercoles a domingo, y ofrece el slot mas cercano disponible.\n\n" +
  "MENU PIZZAS (con numero oficial del menu):\n" +
  "1. El Pelusa (Margarita Clasica) 12eur\n" +
  "2. Zizou (Margarita Bufala) 12.50eur\n" +
  "3. O Rei (Marinara) 10eur\n" +
  "4. Il Gladiatore (Caprichosa) 14.50eur\n" +
  "5. El Gaucho (Diavola) 13eur\n" +
  "6. El Divino Codino (Prosciutto) 12.50eur\n" +
  "7. La Pulga (Jamon y Champinones) 13eur\n" +
  "8. Il Tulipano Nero (Cuatro Quesos) 14.50eur\n" +
  "9. El Ultimo 10 (Atun y Cebolla) 14eur\n" +
  "10. El Mago de Zadar (Vegetariana) 13.50eur\n" +
  "11. El Maestro (Inferno) 13.50eur\n\n" +
  "POSTRES: Tiramisu Clasico 4.50eur, Tiramisu Pistacho 5.50eur, Tiramisu Nutella 5.50eur,\n" +
  "Tiramisu Lotus 5.50eur, Pizza Nutella 7eur,\n" +
  "Tartufo Bianco 5eur, Tartufo Nero 5eur, Tartufo Pistacchio 5eur, Tartufo Limoncello 5eur\n" +
  "BEBIDAS: Estrella Galicia/Heineken 3eur, Peroni 4eur, Refresco 2.50eur, Agua 1.80eur\n\n" +
  "ALERGENOS: Solo menciona alergenos si el cliente pregunta o declara una alergia.";

const NUMEROS_WHITELIST = ["41767011848", "34614267535"];

// Mappature nomi comuni → nomi ufficiali menu
// Usato da agentWhatsapp (interpreta) e agenteMiglioramento (evita di riproporre cose già gestite)
const ABBINAMENTI_NOMI =
  "diavola/diabla=El Gaucho, margherita/clasica=El Pelusa, bufala=Zizou, marinara=O Rei, " +
  "vegetariana=El Mago de Zadar, prosciutto/jamon=El Divino Codino, champinones=La Pulga, " +
  "cuatro quesos=Il Tulipano Nero, atun=El Ultimo 10, caprichosa=Il Gladiatore, inferno=El Maestro, " +
  "coca/cola/fanta=Refresco, cerveza/estrella=Estrella Galicia, heineken=Heineken, agua=Agua";

module.exports = { MENU_LISTA, INFO_RISTORANTE, NUMEROS_WHITELIST, ABBINAMENTI_NOMI };
