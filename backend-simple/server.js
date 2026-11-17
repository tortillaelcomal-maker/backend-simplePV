const path = require("path")
const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mi_tienda_pos"
const JWT_SECRET = process.env.JWT_SECRET || "mi_tienda_pos_secret_cambiar"
const PORT = process.env.PORT || 5001

const app = express()
app.use(cors())
app.use(express.json({ limit: "5mb" }))
app.use(express.static(path.join(__dirname, "..", "frontend-simple")))

// ==================== MODELOS ====================
const userSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  usuario: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  rol: { type: String, enum: ["admin", "cajero"], default: "cajero" },
  activo: { type: Boolean, default: true }
}, { timestamps: true })

const productoSchema = new mongoose.Schema({
  codigo: { type: String, required: true, unique: true, trim: true, uppercase: true },
  nombre: { type: String, required: true, trim: true },
  categoria: { type: String, default: "", trim: true },
  precio: { type: Number, required: true, min: 0 },
  costo: { type: Number, default: 0, min: 0 },
  existencia: { type: Number, default: 0 },
  stockMinimo: { type: Number, default: 5 },
  imagen: { type: String, default: "" },
  activo: { type: Boolean, default: true }
}, { timestamps: true })

const itemSchema = new mongoose.Schema({
  producto: { type: mongoose.Schema.Types.ObjectId, ref: "Producto" },
  codigo: String,
  nombre: String,
  precio: Number,
  cantidad: Number,
  subtotal: Number
}, { _id: false })

const ventaSchema = new mongoose.Schema({
  folio: { type: String, unique: true },
  items: [itemSchema],
  subtotal: Number,
  descuento: { type: Number, default: 0 },
  total: Number,
  metodoPago: { type: String, enum: ["efectivo", "tarjeta", "transferencia"], default: "efectivo" },
  pagoCon: { type: Number, default: 0 },
  cambio: { type: Number, default: 0 },
  origen: { type: String, default: "venta" },
  apartado: String,
  usuario: String,
  fecha: { type: Date, default: Date.now }
}, { timestamps: true })
ventaSchema.index({ fecha: 1 })

const abonoSchema = new mongoose.Schema({
  monto: Number,
  metodoPago: { type: String, default: "efectivo" },
  usuario: String,
  fecha: { type: Date, default: Date.now }
})

const apartadoSchema = new mongoose.Schema({
  folio: { type: String, unique: true },
  cliente: {
    nombre: { type: String, required: true },
    telefono: { type: String, default: "" }
  },
  items: [itemSchema],
  total: Number,
  abonos: [abonoSchema],
  abonado: { type: Number, default: 0 },
  pendiente: Number,
  estado: { type: String, enum: ["activo", "liquidado", "cancelado"], default: "activo" },
  fechaLimite: Date,
  usuario: String,
  fecha: { type: Date, default: Date.now }
}, { timestamps: true })

// Encargos: pedidos por surtir. No mueven inventario ni cobran (el cobro se hace en Ventas)
const encargoItemSchema = new mongoose.Schema({
  producto: { type: mongoose.Schema.Types.ObjectId, ref: "Producto" },
  codigo: { type: String, default: "" },
  nombre: { type: String, required: true },
  cantidad: Number,
  precio: Number,
  subtotal: Number
}, { _id: false })

const encargoSchema = new mongoose.Schema({
  folio: { type: String, unique: true },
  cliente: {
    nombre: { type: String, required: true },
    telefono: { type: String, default: "" }
  },
  items: [encargoItemSchema],
  total: Number,
  notas: { type: String, default: "" },
  fechaEntrega: Date,
  estado: { type: String, enum: ["pendiente", "surtido", "entregado", "cancelado"], default: "pendiente" },
  fechaSurtido: Date,
  fechaEntregado: Date,
  usuario: String,
  fecha: { type: Date, default: Date.now }
}, { timestamps: true })

const configSchema = new mongoose.Schema({
  clave: { type: String, default: "general", unique: true },
  nombreTienda: { type: String, default: "Mi Tienda" },
  direccion: { type: String, default: "" },
  telefono: { type: String, default: "" },
  rfc: { type: String, default: "" },
  mensajeTicket: { type: String, default: "Gracias por su compra" }
})

const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } })

const User = mongoose.model("User", userSchema)
const Producto = mongoose.model("Producto", productoSchema)
const Venta = mongoose.model("Venta", ventaSchema)
const Apartado = mongoose.model("Apartado", apartadoSchema)
const Encargo = mongoose.model("Encargo", encargoSchema)
const Config = mongoose.model("Config", configSchema)
const Counter = mongoose.model("Counter", counterSchema)

async function siguienteFolio(nombre, prefijo, digitos) {
  const c = await Counter.findByIdAndUpdate(nombre, { $inc: { seq: 1 } }, { new: true, upsert: true })
  return `${prefijo}-${String(c.seq).padStart(digitos, "0")}`
}

async function initializeData() {
  if (!await User.findOne({ rol: "admin" })) {
    await User.create({
      nombre: "Administrador",
      usuario: "admin",
      password: await bcrypt.hash("admin123", 10),
      rol: "admin"
    })
    console.log("✓ Usuario admin creado (admin / admin123)")
  }
  if (!await Config.findOne({ clave: "general" })) await Config.create({ clave: "general" })
}

// ==================== HELPERS ====================
const round2 = n => Math.round((Number(n) || 0) * 100) / 100

// fecha "YYYY-MM-DD" -> Date local a las 00:00
function parseFecha(str) {
  if (!str) { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
  const [y, m, d] = str.split("-").map(Number)
  return new Date(y, m - 1, d)
}

// Acepta "YYYY-MM-DD" o una fecha ISO completa (la que manda el navegador en su zona horaria)
function aFecha(v) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? parseFecha(v) : new Date(v)
  if (isNaN(d)) throw fail(400, "Fecha inválida")
  return d
}

function rango(periodo, fechaStr) {
  const base = parseFecha(fechaStr)
  let inicio, fin
  if (periodo === "semana") {
    const dia = (base.getDay() + 6) % 7 // lunes = 0
    inicio = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dia)
    fin = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + 7)
  } else if (periodo === "mes") {
    inicio = new Date(base.getFullYear(), base.getMonth(), 1)
    fin = new Date(base.getFullYear(), base.getMonth() + 1, 1)
  } else if (periodo === "anio") {
    inicio = new Date(base.getFullYear(), 0, 1)
    fin = new Date(base.getFullYear() + 1, 0, 1)
  } else {
    inicio = base
    fin = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1)
  }
  return { inicio, fin }
}

const sumar = ventas => round2(ventas.reduce((s, v) => s + v.total, 0))

// Descuenta existencias de forma atómica; si algo falla regresa lo ya descontado
async function descontarStock(items) {
  const hechos = []
  for (const it of items) {
    const r = await Producto.updateOne(
      { _id: it.producto, existencia: { $gte: it.cantidad } },
      { $inc: { existencia: -it.cantidad } }
    )
    if (r.modifiedCount !== 1) {
      await regresarStock(hechos)
      throw new Error(`Existencia insuficiente de ${it.nombre}`)
    }
    hechos.push(it)
  }
}

async function regresarStock(items) {
  for (const it of items) await Producto.updateOne({ _id: it.producto }, { $inc: { existencia: it.cantidad } })
}

// Convierte [{producto, cantidad}] del cliente a items con precio real de la BD
async function construirItems(entrada) {
  if (!Array.isArray(entrada) || entrada.length === 0) throw new Error("Agrega al menos un producto")
  const items = []
  for (const e of entrada) {
    const cantidad = Number(e.cantidad)
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new Error("Cantidad inválida")
    const p = await Producto.findById(e.producto)
    if (!p || !p.activo) throw new Error("Producto no encontrado")
    items.push({
      producto: p._id, codigo: p.codigo, nombre: p.nombre, precio: p.precio,
      cantidad, subtotal: round2(p.precio * cantidad)
    })
  }
  return items
}

// ==================== AUTH ====================
const auth = (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "")
    if (!token) return res.status(401).json({ success: false, message: "Sesión no iniciada" })
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ success: false, message: "Sesión expirada" })
  }
}

const soloAdmin = (req, res, next) => req.user.rol === "admin"
  ? next()
  : res.status(403).json({ success: false, message: "Solo el administrador puede hacer esto" })

// Envuelve handlers async para responder errores de forma uniforme
const h = fn => async (req, res) => {
  try {
    await fn(req, res)
  } catch (error) {
    const dup = error.code === 11000
    if (!dup && !(error instanceof mongoose.Error.ValidationError) && !error.expose) console.error(error)
    res.status(dup ? 400 : (error.status || 400)).json({
      success: false,
      message: dup ? "Ya existe un registro con ese código/usuario" : error.message
    })
  }
}

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true })

app.get("/api/health", (req, res) => res.json({ status: "OK", db: mongoose.connection.name, timestamp: new Date() }))

app.post("/api/auth/login", h(async (req, res) => {
  const { usuario, password } = req.body
  const user = await User.findOne({ usuario: String(usuario || "").toLowerCase().trim() })
  if (!user || !await bcrypt.compare(password || "", user.password)) throw fail(401, "Usuario o contraseña incorrectos")
  if (!user.activo) throw fail(403, "Tu cuenta está desactivada. Contacta al administrador.")
  const datos = { id: user._id, nombre: user.nombre, usuario: user.usuario, rol: user.rol }
  const token = jwt.sign(datos, JWT_SECRET, { expiresIn: "24h" })
  res.json({ success: true, token, user: datos })
}))

// Registro público: crea un cajero activo y regresa la sesión iniciada
app.post("/api/auth/register", h(async (req, res) => {
  const { nombre, usuario, password } = req.body
  if (!nombre?.trim() || !usuario?.trim() || !password) throw fail(400, "Nombre, usuario y contraseña son requeridos")
  if (password.length < 4) throw fail(400, "La contraseña debe tener al menos 4 caracteres")
  const user = await User.create({ nombre: nombre.trim(), usuario, rol: "cajero", password: await bcrypt.hash(password, 10) })
  const datos = { id: user._id, nombre: user.nombre, usuario: user.usuario, rol: user.rol }
  const token = jwt.sign(datos, JWT_SECRET, { expiresIn: "24h" })
  res.json({ success: true, message: "Cuenta creada", token, user: datos })
}))

app.put("/api/auth/password", auth, h(async (req, res) => {
  const { actual, nueva } = req.body
  const user = await User.findById(req.user.id)
  if (!user || !await bcrypt.compare(actual || "", user.password)) throw fail(400, "La contraseña actual no es correcta")
  if (!nueva || nueva.length < 4) throw fail(400, "La nueva contraseña debe tener al menos 4 caracteres")
  user.password = await bcrypt.hash(nueva, 10)
  await user.save()
  res.json({ success: true, message: "Contraseña actualizada" })
}))

// ==================== USUARIOS ====================
app.get("/api/usuarios", auth, soloAdmin, h(async (req, res) => {
  res.json({ success: true, usuarios: await User.find().select("-password").sort({ nombre: 1 }) })
}))

app.post("/api/usuarios", auth, soloAdmin, h(async (req, res) => {
  const { nombre, usuario, password, rol } = req.body
  if (!nombre || !usuario || !password) throw fail(400, "Nombre, usuario y contraseña son requeridos")
  const u = await User.create({ nombre, usuario, rol, password: await bcrypt.hash(password, 10) })
  res.json({ success: true, message: "Usuario creado", usuario: { ...u.toObject(), password: undefined } })
}))

app.put("/api/usuarios/:id", auth, soloAdmin, h(async (req, res) => {
  const { nombre, usuario, password, rol, activo } = req.body
  const cambios = { nombre, usuario, rol, activo }
  if (password) cambios.password = await bcrypt.hash(password, 10)
  if (String(req.params.id) === String(req.user.id) && (rol === "cajero" || activo === false))
    throw fail(400, "No puedes quitarte permisos ni desactivarte a ti mismo")
  const u = await User.findByIdAndUpdate(req.params.id, cambios, { new: true, runValidators: true }).select("-password")
  if (!u) throw fail(404, "Usuario no encontrado")
  res.json({ success: true, message: "Usuario actualizado", usuario: u })
}))

app.delete("/api/usuarios/:id", auth, soloAdmin, h(async (req, res) => {
  if (String(req.params.id) === String(req.user.id)) throw fail(400, "No puedes eliminar tu propio usuario")
  await User.findByIdAndDelete(req.params.id)
  res.json({ success: true, message: "Usuario eliminado" })
}))

// ==================== PRODUCTOS ====================
app.get("/api/productos", auth, h(async (req, res) => {
  const { q, filtro } = req.query
  const query = { activo: true }
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    query.$or = [{ nombre: rx }, { codigo: rx }, { categoria: rx }]
  }
  if (filtro === "agotado") query.existencia = { $lte: 0 }
  if (filtro === "disponible") query.existencia = { $gt: 0 }
  if (filtro === "bajo") query.$expr = { $and: [{ $gt: ["$existencia", 0] }, { $lte: ["$existencia", "$stockMinimo"] }] }
  res.json({ success: true, productos: await Producto.find(query).sort({ codigo: 1 }) })
}))

app.get("/api/productos/siguiente-codigo", auth, h(async (req, res) => {
  const productos = await Producto.find({ codigo: /^P-\d+$/ }).select("codigo")
  const max = productos.reduce((m, p) => Math.max(m, parseInt(p.codigo.slice(2), 10)), 0)
  res.json({ success: true, codigo: `P-${String(max + 1).padStart(3, "0")}` })
}))

app.post("/api/productos", auth, soloAdmin, h(async (req, res) => {
  const { codigo, nombre, categoria, precio, costo, existencia, stockMinimo, imagen } = req.body
  const existente = await Producto.findOne({ codigo: String(codigo || "").toUpperCase().trim() })
  if (existente && existente.activo) throw fail(400, "Ya existe un producto con ese código")
  if (existente) await existente.deleteOne()
  const p = await Producto.create({ codigo, nombre, categoria, precio, costo, existencia, stockMinimo, imagen })
  res.json({ success: true, message: "Producto creado", producto: p })
}))

app.put("/api/productos/:id", auth, soloAdmin, h(async (req, res) => {
  const { codigo, nombre, categoria, precio, costo, existencia, stockMinimo, imagen } = req.body
  const p = await Producto.findByIdAndUpdate(req.params.id,
    { codigo, nombre, categoria, precio, costo, existencia, stockMinimo, imagen },
    { new: true, runValidators: true })
  if (!p) throw fail(404, "Producto no encontrado")
  res.json({ success: true, message: "Producto actualizado", producto: p })
}))

// Baja lógica para no romper historial de ventas/apartados
app.delete("/api/productos/:id", auth, soloAdmin, h(async (req, res) => {
  const p = await Producto.findByIdAndUpdate(req.params.id, { activo: false })
  if (!p) throw fail(404, "Producto no encontrado")
  res.json({ success: true, message: "Producto eliminado" })
}))

// ==================== VENTAS ====================
app.post("/api/ventas", auth, h(async (req, res) => {
  const { items: entrada, descuento = 0, metodoPago = "efectivo", pagoCon = 0 } = req.body
  const items = await construirItems(entrada)
  const subtotal = round2(items.reduce((s, i) => s + i.subtotal, 0))
  const desc = Math.min(Math.max(round2(descuento), 0), subtotal)
  const total = round2(subtotal - desc)
  const pago = metodoPago === "efectivo" ? round2(pagoCon || total) : total
  if (pago < total) throw fail(400, "El pago es menor al total")

  await descontarStock(items)
  try {
    const venta = await Venta.create({
      folio: await siguienteFolio("venta", "V", 6),
      items, subtotal, descuento: desc, total, metodoPago,
      pagoCon: pago, cambio: round2(pago - total), usuario: req.user.nombre
    })
    res.json({ success: true, message: "Venta registrada", venta })
  } catch (e) {
    await regresarStock(items)
    throw e
  }
}))

app.get("/api/ventas", auth, h(async (req, res) => {
  const { periodo = "dia", fecha } = req.query
  const { inicio, fin } = rango(periodo, fecha)
  res.json({ success: true, ventas: await Venta.find({ fecha: { $gte: inicio, $lt: fin } }).sort({ fecha: -1 }) })
}))

app.get("/api/ventas/:id", auth, h(async (req, res) => {
  const venta = await Venta.findById(req.params.id)
  if (!venta) throw fail(404, "Venta no encontrada")
  res.json({ success: true, venta })
}))

// ==================== APARTADOS ====================
app.get("/api/apartados", auth, h(async (req, res) => {
  const { q, estado } = req.query
  const query = {}
  if (estado === "sinLiquidar") query.estado = { $ne: "liquidado" }
  else if (estado && estado !== "todos") query.estado = estado
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    query.$or = [{ folio: rx }, { "cliente.nombre": rx }, { "cliente.telefono": rx }]
  }
  res.json({ success: true, apartados: await Apartado.find(query).sort({ fecha: -1 }) })
}))

app.get("/api/apartados/:id", auth, h(async (req, res) => {
  const a = await Apartado.findById(req.params.id)
  if (!a) throw fail(404, "Apartado no encontrado")
  res.json({ success: true, apartado: a })
}))

app.post("/api/apartados", auth, h(async (req, res) => {
  const { cliente, items: entrada, anticipo = 0, metodoPago = "efectivo", fechaLimite } = req.body
  if (!cliente?.nombre?.trim()) throw fail(400, "El nombre del cliente es requerido")
  const items = await construirItems(entrada)
  const total = round2(items.reduce((s, i) => s + i.subtotal, 0))
  const abono = round2(anticipo)
  if (abono < 0 || abono > total) throw fail(400, "El anticipo debe estar entre $0 y el total")

  await descontarStock(items)
  try {
    const apartado = await Apartado.create({
      folio: await siguienteFolio("apartado", "AP", 4),
      cliente: { nombre: cliente.nombre.trim(), telefono: (cliente.telefono || "").trim() },
      items, total,
      abonos: abono > 0 ? [{ monto: abono, metodoPago, usuario: req.user.nombre }] : [],
      abonado: abono, pendiente: round2(total - abono),
      fechaLimite: fechaLimite ? aFecha(fechaLimite) : undefined,
      usuario: req.user.nombre
    })
    if (apartado.pendiente === 0) await liquidar(apartado, metodoPago, req.user.nombre)
    res.json({ success: true, message: "Apartado creado", apartado })
  } catch (e) {
    await regresarStock(items)
    throw e
  }
}))

// Al liquidar se genera una venta para que cuente en reportes
async function liquidar(apartado, metodoPago, usuario) {
  apartado.estado = "liquidado"
  apartado.pendiente = 0
  await apartado.save()
  return Venta.create({
    folio: await siguienteFolio("venta", "V", 6),
    items: apartado.items, subtotal: apartado.total, descuento: 0, total: apartado.total,
    metodoPago, pagoCon: apartado.total, cambio: 0,
    origen: "apartado", apartado: apartado.folio, usuario
  })
}

app.post("/api/apartados/:id/abono", auth, h(async (req, res) => {
  const a = await Apartado.findById(req.params.id)
  if (!a) throw fail(404, "Apartado no encontrado")
  if (a.estado !== "activo") throw fail(400, `El apartado está ${a.estado}`)
  const monto = req.body.liquidar ? a.pendiente : round2(req.body.monto)
  const metodoPago = req.body.metodoPago || "efectivo"
  if (!(monto > 0) || monto > a.pendiente) throw fail(400, `El abono debe ser mayor a $0 y máximo $${a.pendiente.toFixed(2)}`)

  a.abonos.push({ monto, metodoPago, usuario: req.user.nombre })
  a.abonado = round2(a.abonado + monto)
  a.pendiente = round2(a.total - a.abonado)
  await a.save()
  if (a.pendiente === 0) await liquidar(a, metodoPago, req.user.nombre)
  res.json({ success: true, message: a.estado === "liquidado" ? "Apartado liquidado" : "Abono registrado", apartado: a, abono: monto })
}))

// Edición: cliente y fechas siempre; productos y montos de abonos solo si está activo
app.put("/api/apartados/:id", auth, soloAdmin, h(async (req, res) => {
  const a = await Apartado.findById(req.params.id)
  if (!a) throw fail(404, "Apartado no encontrado")
  const { cliente, fecha, fechaLimite, items: entrada, abonos } = req.body
  const activo = a.estado === "activo"

  if (cliente) {
    if (!cliente.nombre?.trim()) throw fail(400, "El nombre del cliente es requerido")
    a.cliente = { nombre: cliente.nombre.trim(), telefono: String(cliente.telefono || "").trim() }
  }
  if (fecha) a.fecha = aFecha(fecha)
  if (fechaLimite !== undefined) a.fechaLimite = fechaLimite ? aFecha(fechaLimite) : undefined

  if (Array.isArray(abonos)) {
    if (!activo && abonos.length !== a.abonos.length) throw fail(400, "Solo se pueden quitar abonos de apartados activos")
    a.abonos = abonos.map(e => {
      const ab = a.abonos.id(e._id)
      if (!ab) throw fail(400, "Abono no encontrado")
      const monto = round2(e.monto)
      if (!(monto > 0)) throw fail(400, "Los abonos deben ser mayores a $0")
      if (!activo && monto !== ab.monto) throw fail(400, "Solo se pueden cambiar montos de apartados activos")
      return { ...ab.toObject(), monto, fecha: e.fecha ? aFecha(e.fecha) : ab.fecha }
    })
  }

  const sacar = [], devolver = []
  if (entrada) {
    if (!activo) throw fail(400, "Solo se pueden cambiar productos de apartados activos")
    if (!Array.isArray(entrada) || !entrada.length) throw fail(400, "Agrega al menos un producto")
    const items = []
    for (const e of entrada) {
      const cantidad = Number(e.cantidad)
      if (!Number.isInteger(cantidad) || cantidad <= 0) throw fail(400, "Cantidad inválida")
      if (items.some(i => String(i.producto) === String(e.producto))) throw fail(400, "Producto repetido")
      // Los productos que ya estaban conservan el precio con el que se apartaron
      const previo = a.items.find(i => String(i.producto) === String(e.producto))
      items.push(previo
        ? { ...previo.toObject(), cantidad, subtotal: round2(previo.precio * cantidad) }
        : (await construirItems([e]))[0])
    }
    for (const id of new Set([...a.items, ...items].map(i => String(i.producto)))) {
      const antes = a.items.find(i => String(i.producto) === id)
      const ahora = items.find(i => String(i.producto) === id)
      const d = (ahora?.cantidad || 0) - (antes?.cantidad || 0)
      if (d > 0) sacar.push({ producto: id, nombre: ahora.nombre, cantidad: d })
      if (d < 0) devolver.push({ producto: id, cantidad: -d })
    }
    a.items = items
  }

  if (activo) {
    a.total = round2(a.items.reduce((s, i) => s + i.subtotal, 0))
    a.abonado = round2(a.abonos.reduce((s, x) => s + x.monto, 0))
    if (a.abonado > a.total) throw fail(400, `Lo abonado ($${a.abonado.toFixed(2)}) no puede ser mayor al total ($${a.total.toFixed(2)})`)
    a.pendiente = round2(a.total - a.abonado)
  }

  await a.validate()
  await descontarStock(sacar)
  try {
    await regresarStock(devolver)
    await a.save()
  } catch (e) {
    await regresarStock(sacar)
    for (const it of devolver) await Producto.updateOne({ _id: it.producto }, { $inc: { existencia: -it.cantidad } })
    throw e
  }
  if (activo && a.pendiente === 0) await liquidar(a, a.abonos.at(-1)?.metodoPago || "efectivo", req.user.nombre)
  res.json({ success: true, message: a.estado === "liquidado" ? "Apartado actualizado y liquidado" : "Apartado actualizado", apartado: a })
}))

app.post("/api/apartados/:id/cancelar", auth, h(async (req, res) => {
  const a = await Apartado.findById(req.params.id)
  if (!a) throw fail(404, "Apartado no encontrado")
  if (a.estado !== "activo") throw fail(400, `El apartado ya está ${a.estado}`)
  await regresarStock(a.items)
  a.estado = "cancelado"
  await a.save()
  res.json({ success: true, message: "Apartado cancelado, existencias devueltas", apartado: a })
}))

// ==================== ENCARGOS ====================
// [{producto?, nombre, cantidad, precio}] -> items; con producto toma código/nombre del inventario
async function itemsEncargo(entrada) {
  if (!Array.isArray(entrada) || !entrada.length) throw fail(400, "Agrega al menos un producto")
  const items = []
  for (const e of entrada) {
    const cantidad = Number(e.cantidad), precio = round2(e.precio)
    if (!(cantidad > 0)) throw fail(400, "Cantidad inválida")
    if (!(precio >= 0)) throw fail(400, "Precio inválido")
    let { codigo = "", nombre = "" } = e
    if (e.producto) {
      const p = await Producto.findById(e.producto)
      if (!p) throw fail(400, "Producto no encontrado")
      codigo = p.codigo
      nombre = p.nombre
    }
    nombre = String(nombre).trim()
    if (!nombre) throw fail(400, "Escribe la descripción de cada producto")
    items.push({ producto: e.producto || undefined, codigo, nombre, cantidad, precio, subtotal: round2(precio * cantidad) })
  }
  return items
}

function datosEncargo(body) {
  const { cliente, notas, fechaEntrega } = body
  if (!cliente?.nombre?.trim()) throw fail(400, "El nombre del cliente es requerido")
  return {
    cliente: { nombre: cliente.nombre.trim(), telefono: String(cliente.telefono || "").trim() },
    notas: String(notas || "").trim(),
    fechaEntrega: fechaEntrega ? aFecha(fechaEntrega) : undefined
  }
}

app.get("/api/encargos", auth, h(async (req, res) => {
  const { q, estado } = req.query
  const query = {}
  if (estado === "abiertos") query.estado = { $in: ["pendiente", "surtido"] }
  else if (estado && estado !== "todos") query.estado = estado
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    query.$or = [{ folio: rx }, { "cliente.nombre": rx }, { "cliente.telefono": rx }, { "items.nombre": rx }]
  }
  res.json({ success: true, encargos: await Encargo.find(query).sort({ fechaEntrega: 1, fecha: -1 }) })
}))

app.get("/api/encargos/:id", auth, h(async (req, res) => {
  const e = await Encargo.findById(req.params.id)
  if (!e) throw fail(404, "Encargo no encontrado")
  res.json({ success: true, encargo: e })
}))

app.post("/api/encargos", auth, h(async (req, res) => {
  const datos = datosEncargo(req.body)
  const items = await itemsEncargo(req.body.items)
  const encargo = await Encargo.create({
    ...datos, items, total: round2(items.reduce((s, i) => s + i.subtotal, 0)),
    folio: await siguienteFolio("encargo", "EN", 4), usuario: req.user.nombre
  })
  res.json({ success: true, message: "Encargo registrado", encargo })
}))

app.put("/api/encargos/:id", auth, soloAdmin, h(async (req, res) => {
  const e = await Encargo.findById(req.params.id)
  if (!e) throw fail(404, "Encargo no encontrado")
  const datos = datosEncargo(req.body)
  const items = await itemsEncargo(req.body.items)
  Object.assign(e, datos, { items, total: round2(items.reduce((s, i) => s + i.subtotal, 0)) })
  if (req.body.fecha) e.fecha = aFecha(req.body.fecha)
  if (!datos.fechaEntrega) e.fechaEntrega = undefined
  await e.save()
  res.json({ success: true, message: "Encargo actualizado", encargo: e })
}))

// Cualquiera avanza el estado (pendiente -> surtido -> entregado); regresar o cancelar solo el admin
const ORDEN_ENCARGO = ["pendiente", "surtido", "entregado"]
app.post("/api/encargos/:id/estado", auth, h(async (req, res) => {
  const e = await Encargo.findById(req.params.id)
  if (!e) throw fail(404, "Encargo no encontrado")
  const { estado } = req.body
  const admin = req.user.rol === "admin"
  if (estado !== "cancelado" && !ORDEN_ENCARGO.includes(estado)) throw fail(400, "Estado inválido")
  if (estado === e.estado) throw fail(400, `El encargo ya está ${estado}`)
  if (!admin && (estado === "cancelado" || e.estado === "cancelado" || ORDEN_ENCARGO.indexOf(estado) < ORDEN_ENCARGO.indexOf(e.estado)))
    throw fail(403, "Solo el administrador puede cancelar o regresar un encargo")
  e.estado = estado
  if (estado === "pendiente") { e.fechaSurtido = undefined; e.fechaEntregado = undefined }
  if (estado === "surtido") e.fechaSurtido = new Date()
  if (estado === "entregado") e.fechaEntregado = new Date()
  await e.save()
  res.json({ success: true, message: `Encargo ${estado}`, encargo: e })
}))

// ==================== REPORTES ====================
app.get("/api/reportes/dashboard", auth, h(async (req, res) => {
  const { fecha, periodo = "semana" } = req.query
  const dia = rango("dia", fecha), semana = rango("semana", fecha), mes = rango("mes", fecha)
  const enRango = r => Venta.find({ fecha: { $gte: r.inicio, $lt: r.fin } }).select("total fecha")

  const [vDia, vSemana, vMes] = await Promise.all([enRango(dia), enRango(semana), enRango(mes)])

  let etiquetas, idx, ventasGrafica
  if (periodo === "mes") {
    const dias = new Date(mes.inicio.getFullYear(), mes.inicio.getMonth() + 1, 0).getDate()
    etiquetas = Array.from({ length: dias }, (_, i) => String(i + 1))
    idx = f => f.getDate() - 1
    ventasGrafica = vMes
  } else if (periodo === "anio") {
    etiquetas = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    idx = f => f.getMonth()
    ventasGrafica = await enRango(rango("anio", fecha))
  } else {
    etiquetas = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
    idx = f => (f.getDay() + 6) % 7
    ventasGrafica = vSemana
  }
  const valores = etiquetas.map(() => 0)
  ventasGrafica.forEach(v => { valores[idx(v.fecha)] += v.total })

  const [apartadosActivos, bajoStock] = await Promise.all([
    Apartado.countDocuments({ estado: "activo" }),
    Producto.countDocuments({ activo: true, $expr: { $lte: ["$existencia", "$stockMinimo"] } })
  ])

  res.json({
    success: true,
    ventasDia: sumar(vDia), ventasSemana: sumar(vSemana), ventasMes: sumar(vMes),
    numVentasDia: vDia.length, apartadosActivos, bajoStock,
    grafica: { etiquetas, valores: valores.map(round2) }
  })
}))

app.get("/api/reportes/ventas", auth, h(async (req, res) => {
  const { periodo = "dia", fecha } = req.query
  const { inicio, fin } = rango(periodo, fecha)
  const ventas = await Venta.find({ fecha: { $gte: inicio, $lt: fin } }).sort({ fecha: -1 })
  const total = sumar(ventas)
  const porMetodo = { efectivo: 0, tarjeta: 0, transferencia: 0 }
  ventas.forEach(v => { porMetodo[v.metodoPago] = round2((porMetodo[v.metodoPago] || 0) + v.total) })

  const productos = {}
  ventas.forEach(v => v.items.forEach(i => {
    const p = productos[i.codigo] ||= { codigo: i.codigo, nombre: i.nombre, cantidad: 0, total: 0 }
    p.cantidad += i.cantidad
    p.total = round2(p.total + i.subtotal)
  }))

  res.json({
    success: true,
    inicio, fin: new Date(fin.getTime() - 1),
    total, numVentas: ventas.length,
    ticketPromedio: ventas.length ? round2(total / ventas.length) : 0,
    porMetodo,
    topProductos: Object.values(productos).sort((a, b) => b.cantidad - a.cantidad).slice(0, 10),
    ventas
  })
}))

// ==================== CONFIGURACIÓN ====================
app.get("/api/config", auth, h(async (req, res) => {
  res.json({ success: true, config: await Config.findOne({ clave: "general" }) })
}))

app.put("/api/config", auth, soloAdmin, h(async (req, res) => {
  const { nombreTienda, direccion, telefono, rfc, mensajeTicket } = req.body
  const config = await Config.findOneAndUpdate({ clave: "general" },
    { nombreTienda, direccion, telefono, rfc, mensajeTicket }, { new: true, upsert: true })
  res.json({ success: true, message: "Configuración guardada", config })
}))

// ==================== INICIO ====================
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log(`✓ MongoDB conectado: ${MONGO_URI}`)
    await initializeData()
    app.listen(PORT, () => {
      console.log(`✓ Servidor en http://localhost:${PORT}`)
      console.log(`✓ API en http://localhost:${PORT}/api`)
    })
  })
  .catch(err => {
    console.error("✗ No se pudo conectar a MongoDB:", err.message)
    console.error("  Asegúrate de que mongod esté corriendo (ver iniciar-mongo.bat)")
    process.exit(1)
  })
