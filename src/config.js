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
  "12. Parmazola - Parma y Gorgonzola 16.50",
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
  "RESTAURANTE: La Dieci Pizzeria\n" +
  "DIRECCIÓN: Plaza Italica 8, 04740 Roquetas de Mar (Almeria)\n" +
  "TELÉFONO: 614 267 535\n" +
  "HORARIO RECOGIDA EN LOCAL: Miércoles a Domingo 19:30 - 23:00\n" +
  "HORARIO REPARTO A DOMICILIO: Miércoles a Domingo 20:00 - 23:00\n" +
  "CERRADO: Lunes y Martes\n\n" +
  "MODALIDADES DE PEDIDO:\n" +
  "1. RECOGIDA EN LOCAL: disponible desde las 19:30 (miércoles a domingo)\n" +
  "2. REPARTO A DOMICILIO: disponible desde las 20:00 (miércoles a domingo)\n" +
  "   - Coste de envío: 2.50€ (pago en efectivo al repartidor)\n" +
  "   - Sin pedido mínimo\n\n" +
  "PEDIDOS FUERA DE HORARIO: el bot está activo 24h. Si alguien pide recogida antes\n" +
  "de las 19:30, o domicilio antes de las 20:00, o un lunes o martes, responde con\n" +
  "simpatía indicando el horario correcto y el slot más cercano disponible.\n\n" +
  "MENÚ PIZZAS (con número oficial del menú):\n" +
  "1. El Pelusa (Margarita Clásica) 12€\n" +
  "2. Zizou (Margarita Búfala) 12.50€\n" +
  "3. O Rei (Marinara) 10€\n" +
  "4. Il Gladiatore (Caprichosa) 14.50€\n" +
  "5. El Gaucho (Diavola) 13€\n" +
  "6. El Divino Codino (Prosciutto) 12.50€\n" +
  "7. La Pulga (Jamón y Champiñones) 13€\n" +
  "8. Il Tulipano Nero (Cuatro Quesos) 14.50€\n" +
  "9. El Ultimo 10 (Atún y Cebolla) 14€\n" +
  "10. El Mago de Zadar (Vegetariana) 13.50€\n" +
  "11. El Maestro (Inferno) 13.50€\n" +
  "12. Parmazola (Parma y Gorgonzola) 16.50€\n\n" +
  "POSTRES: Tiramisú Clásico 4.50€, Tiramisú Pistacho 5.50€, Tiramisú Nutella 5.50€,\n" +
  "Tiramisú Lotus 5.50€, Pizza Nutella 7€,\n" +
  "Tartufo Bianco 5€, Tartufo Nero 5€, Tartufo Pistacchio 5€, Tartufo Limoncello 5€\n" +
  "BEBIDAS: Estrella Galicia/Heineken 3€, Peroni 4€, Refresco 2.50€, Agua 1.80€\n\n" +
  "ALÉRGENOS: solo menciona alérgenos si el cliente pregunta o declara una alergia.";

const COSTO_CONSEGNA = 2.50;

const NUMEROS_WHITELIST = ["41767011848", "34614267535"];

// Mappature nomi comuni → nomi ufficiali menu
const ABBINAMENTI_NOMI =
  "diavola/diabla=El Gaucho, margherita/clasica=El Pelusa, bufala=Zizou, marinara=O Rei, " +
  "vegetariana=El Mago de Zadar, prosciutto/jamon=El Divino Codino, champinones=La Pulga, " +
  "cuatro quesos=Il Tulipano Nero, atun=El Ultimo 10, caprichosa=Il Gladiatore, inferno=El Maestro, " +
  "parmazola/parma gorgonzola=Parmazola, " +
  "coca/cola/fanta=Refresco, cerveza/estrella=Estrella Galicia, heineken=Heineken, agua=Agua";

module.exports = { MENU_LISTA, INFO_RISTORANTE, NUMEROS_WHITELIST, ABBINAMENTI_NOMI, COSTO_CONSEGNA };
