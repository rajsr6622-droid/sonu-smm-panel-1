require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const Razorpay = require("razorpay");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database("sonu-smm.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
 password_hash TEXT, google_id TEXT UNIQUE, wallet_paise INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 service_id TEXT NOT NULL, link TEXT NOT NULL, quantity INTEGER NOT NULL,
 charge_paise INTEGER NOT NULL, provider_order_id TEXT, status TEXT NOT NULL DEFAULT 'Pending',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 razorpay_order_id TEXT UNIQUE NOT NULL, amount_paise INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7*24*60*60*1000 }
}));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

const googleClient = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALLBACK_URL)
  : null;
const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare("SELECT id,email,wallet_paise,created_at FROM users WHERE id=?").get(req.session.userId) || null;
}
function requireAuth(req,res,next) {
  if (!currentUser(req)) return res.status(401).json({error:"पहले लॉगिन करें"});
  next();
}
function amountPaise(n) { return Math.round(Number(n) * 100); }
function validEmail(s) { return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

app.get("/api/config", (req,res) => res.json({
  googleEnabled: !!googleClient, razorpayEnabled: !!razorpay,
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
  user: currentUser(req)
}));

app.post("/api/register", async (req,res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!validEmail(email) || password.length < 8) return res.status(400).json({error:"सही ईमेल और कम-से-कम 8 अक्षर का पासवर्ड दें"});
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users(email,password_hash) VALUES(?,?)").run(email,hash);
    req.session.userId = Number(result.lastInsertRowid);
    res.json({ok:true,user:currentUser(req)});
  } catch(e) { res.status(409).json({error:"यह ईमेल पहले से इस्तेमाल हो सकता है"}); }
});
app.post("/api/login", async (req,res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !user.password_hash || !(await bcrypt.compare(password,user.password_hash)))
    return res.status(401).json({error:"ईमेल या पासवर्ड सही नहीं है"});
  req.session.userId = user.id; res.json({ok:true,user:currentUser(req)});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("/auth/google", (req,res) => {
  if (!googleClient) return res.status(503).send("Google login setup नहीं है। .env में Google OAuth credentials जोड़ें।");
  const url = googleClient.generateAuthUrl({ access_type:"online", scope:["openid","email","profile"], prompt:"select_account" });
  res.redirect(url);
});
app.get("/auth/google/callback", async (req,res) => {
  if (!googleClient) return res.redirect("/?error=google_not_configured");
  try {
    const {tokens} = await googleClient.getToken(String(req.query.code || ""));
    const ticket = await googleClient.verifyIdToken({idToken:tokens.id_token, audience:process.env.GOOGLE_CLIENT_ID});
    const p = ticket.getPayload();
    if (!p || !p.email || !p.email_verified) return res.redirect("/?error=google_email_not_verified");
    let user = db.prepare("SELECT * FROM users WHERE email=?").get(p.email.toLowerCase());
    if (!user) {
      const result = db.prepare("INSERT INTO users(email,google_id) VALUES(?,?)").run(p.email.toLowerCase(),p.sub);
      user = {id:Number(result.lastInsertRowid)};
    } else if (!user.google_id) db.prepare("UPDATE users SET google_id=? WHERE id=?").run(p.sub,user.id);
    req.session.userId = user.id; res.redirect("/");
  } catch(e) { console.error("Google OAuth error:",e.message); res.redirect("/?error=google_login_failed"); }
});

async function smmRequest(fields) {
  if (!process.env.SMM_API_KEY) throw new Error("Hanuman SMM API key सेट नहीं है");
  const body = new URLSearchParams({key:process.env.SMM_API_KEY,...fields});
  const r = await fetch(process.env.SMM_API_URL || "https://hanumansmm.in/api/v2", {method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || "Supplier API error");
  return data;
}
app.get("/api/services", async (req,res) => {
  try {
    const services = await smmRequest({action:"services"});
    res.json({services});
  } catch(e) {
    res.json({demo:true, warning:e.message, services:[
      {service:"101",name:"Instagram Likes (demo only)",category:"Instagram",rate:"0.50",min:"100",max:"10000"},
      {service:"201",name:"Telegram Members (demo only)",category:"Telegram",rate:"2.00",min:"50",max:"5000"},
      {service:"301",name:"YouTube Views (demo only)",category:"YouTube",rate:"1.00",min:"100",max:"50000"}
    ]});
  }
});
app.get("/api/balance", requireAuth, async (req,res) => {
  try { res.json({wallet_paise:currentUser(req).wallet_paise, supplier:await smmRequest({action:"balance"})}); }
  catch(e) { res.json({wallet_paise:currentUser(req).wallet_paise, supplier:null, warning:e.message}); }
});
app.get("/api/orders", requireAuth, (req,res) => {
  res.json({orders:db.prepare("SELECT id,service_id,link,quantity,charge_paise,status,created_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100").all(req.session.userId)});
});
app.post("/api/orders", requireAuth, async (req,res) => {
  const serviceId=String(req.body.service_id||"").trim(), link=String(req.body.link||"").trim();
  const quantity=Number(req.body.quantity), pricePerThousand=Number(req.body.rate);
  if(!serviceId || !/^https?:\/\//i.test(link) || !Number.isInteger(quantity) || quantity<1 || !Number.isFinite(pricePerThousand) || pricePerThousand<=0)
    return res.status(400).json({error:"Service, सही URL, quantity और rate जरूरी हैं"});
  // The frontend-provided rate is not safe for production. Replace with server-side supplier price mapping before launch.
  const charge=amountPaise((quantity/1000)*pricePerThousand);
  const user=currentUser(req);
  if(user.wallet_paise<charge) return res.status(400).json({error:"Wallet balance कम है। पहले payment करें।"});
  try {
    const supplier=await smmRequest({action:"add",service:serviceId,link,quantity:String(quantity)});
    const tx=db.transaction(()=>{
      db.prepare("UPDATE users SET wallet_paise=wallet_paise-? WHERE id=?").run(charge,user.id);
      return db.prepare("INSERT INTO orders(user_id,service_id,link,quantity,charge_paise,provider_order_id,status) VALUES(?,?,?,?,?,?,?)")
        .run(user.id,serviceId,link,quantity,charge,String(supplier.order||""),"Pending");
    });
    const result=tx();
    res.json({ok:true,order_id:Number(result.lastInsertRowid),supplier_order_id:supplier.order});
  } catch(e) { res.status(502).json({error:"Supplier order नहीं बना: "+e.message}); }
});
app.get("/api/orders/:id/status", requireAuth, async (req,res) => {
  const order=db.prepare("SELECT * FROM orders WHERE id=? AND user_id=?").get(Number(req.params.id),req.session.userId);
  if(!order) return res.status(404).json({error:"Order नहीं मिला"});
  if(!order.provider_order_id) return res.json({status:order.status, demo:true});
  try {
    const s=await smmRequest({action:"status",order:order.provider_order_id});
    const status=s.status || s;
    db.prepare("UPDATE orders SET status=? WHERE id=?").run(typeof status==="string"?status:JSON.stringify(status),order.id);
    res.json({status});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.post("/api/payment/create", requireAuth, async (req,res) => {
  const amount=Number(req.body.amount);
  if(!Number.isFinite(amount) || amount<10 || amount>50000) return res.status(400).json({error:"₹10 से ₹50,000 तक amount डालें"});
  if(!razorpay) return res.status(503).json({error:"Razorpay test/live keys अभी configure नहीं हैं"});
  try {
    const order=await razorpay.orders.create({amount:amountPaise(amount),currency:"INR",receipt:"sonu_"+Date.now()});
    db.prepare("INSERT INTO payments(user_id,razorpay_order_id,amount_paise) VALUES(?,?,?)").run(req.session.userId,order.id,order.amount);
    res.json({order_id:order.id,amount:order.amount,currency:order.currency,key_id:process.env.RAZORPAY_KEY_ID});
  } catch(e) { res.status(502).json({error:"Payment order create नहीं हुआ"}); }
});
app.post("/api/payment/verify", requireAuth, (req,res) => {
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
  const payment=db.prepare("SELECT * FROM payments WHERE razorpay_order_id=? AND user_id=?").get(razorpay_order_id,req.session.userId);
  if(!payment || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({error:"Payment details invalid"});
  const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET||"").update(razorpay_order_id+"|"+razorpay_payment_id).digest("hex");
  if(expected.length!==razorpay_signature.length || !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpay_signature))) return res.status(400).json({error:"Payment signature verify नहीं हुआ"});
  const tx=db.transaction(()=>{
    const p=db.prepare("SELECT status FROM payments WHERE id=?").get(payment.id);
    if(p.status==="paid") return;
    db.prepare("UPDATE payments SET status='paid' WHERE id=?").run(payment.id);
    db.prepare("UPDATE users SET wallet_paise=wallet_paise+? WHERE id=?").run(payment.amount_paise,req.session.userId);
  });
  tx(); res.json({ok:true, message:"Payment verified; wallet credited"});
});
app.post("/api/payment/webhook", express.raw({type:"application/json"}), (req,res) => {
  const secret=process.env.RAZORPAY_WEBHOOK_SECRET;
  if(!secret) return res.status(503).send("Webhook secret not configured");
  const signature=req.headers["x-razorpay-signature"]||"";
  const expected=crypto.createHmac("sha256",secret).update(req.body).digest("hex");
  if(signature.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return res.status(400).send("Invalid signature");
  // Production note: reconcile payment.captured events against order/payment IDs before crediting wallet.
  res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Sonu SMM Panel listening on ${PORT}`));
