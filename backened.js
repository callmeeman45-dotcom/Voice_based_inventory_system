const dotenv = require("dotenv");
dotenv.config();
const mongoose=require("mongoose");
const express =require("express");
// const ejsmate = require('ejs-mate')
const app = express();
app.use(express.json());
app.set("view engine", "ejs");
const path = require("path");
// app.set("public", path.join(__dirname, "public"));
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
// app.use(methodoverride("_method"));
// app.engine('ejs', ejsmate);
const session=require("express-session");
// 1: require connect-flash
const User=require("./models/users.js");
const Product=require("./models/product.js");
const passportLocalMongoose= require("passport-local-mongoose").default;
const LocalStrategy=require("passport-local").Strategy;
const passport = require("passport");
const {Groq} = require("groq-sdk");
const fs = require("fs");
const fetch = require("node-fetch");
// const multer  = require('multer')
// const upload = multer({ storage })
const multer = require("multer");
const MongoStore = require("connect-mongo").default;


const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "/tmp");
  },
  filename: (req, file, cb) => {
    cb(
      null,
      Date.now() + path.extname(file.originalname)
    );
  }
});

const upload = multer({ storage });

// Middleware to parse JSON requests
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.CONNECTION_STRING)
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));



const store=MongoStore.create({
  mongoUrl:process.env.CONNECTION_STRING,
  crypto:{
     secret:process.env.SECRET,
  },
  touchAfter:24*3600,
});
app.use(session({
  store,
    secret:process.env.SECRET,
    resave:false,
    saveUninitialized:true,
    cookies:{
      expires:Date.now()+7*24*60*60*1000,
      maxAge:7*24*60*60*1000,
      httpOnly:true
    }
}));


app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());


const IsloggedIn=(req,res,next)=>{
    if(req.isAuthenticated()){
        return next();
    }
    res.redirect("/login");
}

const groq= new Groq({ apiKey:process.env.GROQ_API_KEY});

// ── Audio → Text (Whisper on Groq) ────────────────────────────────────
const transcribeAudio = async (filePath) => {
  const transcription = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-large-v3-turbo',
    language: 'ur', // Urdu script + Roman Urdu
    response_format: 'text',
  });

  return typeof transcription === 'string' ? transcription : transcription.text;
};

// ── Text → Structured Intent JSON (LLaMA on Groq) ─────────────────────
const parseIntent = async (transcribedText) => {
  const systemPrompt = `
You are an inventory management assistant for a Pakistani shop owner.
The user speaks in Urdu, Roman Urdu, English, or a mix of all three.

Your ONLY job is to parse the user's voice/text command and return a strict JSON object.
Return NOTHING else — no explanation, no markdown, no code fences. Only raw JSON.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUPPORTED ACTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"add"       → Add a new product to inventory (default status: "not-sold")
"update"    → Update quantity, price, or status of an existing product
"delete"    → Remove a product from inventory
"sale"      → Record a sale (decreases quantity, marks units as "sold")
"purchase"  → Record stock purchase (increases quantity of existing product)
"check"     → Check current stock level of a product
"report"    → Generate a sales/stock report (today / week / month)
"low_stock" → Show all items below their minimum threshold
"unknown"   → Command not understood or too ambiguous

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRODUCT NAME RULE (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"productName" MUST always be in English, regardless of what language the user spoke.
Translate or transliterate the product name to its standard English equivalent.

Examples:
  "chawal"       → "Rice"
  "doodh"        → "Milk"
  "anda"         → "Egg"
  "tel"          → "Cooking Oil"
  "aata"         → "Flour"
  "cheeni"       → "Sugar"
  "namak"        → "Salt"
  "sabun"        → "Soap"
  "biscut"       → "Biscuit"
  "lal mirch"    → "Red Chilli"
  "haldi"        → "Turmeric"
  "dhaniya"      → "Coriander"

This ensures all database records use consistent English product names.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATUS RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When action = "add"    → status should be "not-sold" (product just entered stock)
When action = "update" and user says "bech do", "sell karo", "sold mein dalo"
                       → status should be "sold" (units are now listed for sale)
When action = "sale"   → status should be "sold" (units have been sold to a customer)
For all other actions  → status = null
"sara stock dikhao"         → action: "all_stock"
"poora maal kitna hai"      → action: "all_stock"
"inventory mein kya kya hai"→ action: "all_stock"
"sab cheezein dikhao"       → action: "all_stock"
This three-state model lets you track:
  - Total stock added       (not-sold records)
  - What is actively listed (sold records)
  - What has been sold      (sold records)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RETURN FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "action":      "add" | "update" | "delete" | "sale" | "purchase" | "check" | "report" | "low_stock" | "unknown",
  "productName": string (English) | null,
  "quantity":    number | null,
  "unit":        "kg" | "gram" | "litre" | "ml" | "packet" | "box" | "piece" | "pcs" | "dozen" | null,
  "costPrice":   number | null,
  "salePrice":   number | null,
  "category":    string | null,
  "status":      "not-sold" | "sold" | null,
  "period":      "today" | "week" | "month" | null,
  "confidence":  "high" | "medium" | "low"
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIELD RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Use null for any field the user did not mention.
- costPrice  = price the shop owner BOUGHT the product for (purchase cost).
- salePrice  = price the shop owner SELLS the product to customers.
- confidence = "high"   if you are certain about the parsed intent
              "medium"  if one or two fields are ambiguous
              "low"     if the command is unclear or partially understood

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Input:  "50 kg chawal add karo, cost 120 rupay kilo"
Output: {"action":"add","productName":"Rice","quantity":50,"unit":"kg","costPrice":120,"salePrice":null,"category":null,"status":"not-sold","period":null,"confidence":"high"}

Input:  "chawal ki sale price 150 rakho aur sold mein dalo"
Output: {"action":"update","productName":"Rice","quantity":null,"unit":null,"costPrice":null,"salePrice":150,"category":null,"status":"sold","period":null,"confidence":"high"}

Input:  "aaj 5 kg chawal bika, 150 rupay kilo"
Output: {"action":"sale","productName":"Rice","quantity":5,"unit":"kg","costPrice":null,"salePrice":150,"category":null,"status":"sold","period":null,"confidence":"high"}

Input:  "doodh ka stock check karo"
Output: {"action":"check","productName":"Milk","quantity":null,"unit":null,"costPrice":null,"salePrice":null,"category":null,"status":null,"period":null,"confidence":"high"}

Input:  "is hafte ki report chahiye"
Output: {"action":"report","productName":null,"quantity":null,"unit":null,"costPrice":null,"salePrice":null,"category":null,"status":null,"period":"week","period":null,"confidence":"high"}

Input:  "konsa maal khatam ho raha hai"
Output: {"action":"low_stock","productName":null,"quantity":null,"unit":null,"costPrice":null,"salePrice":null,"category":null,"status":null,"period":null,"confidence":"high"}

Input:  "20 packet biscuit aur gaya, 30 rupay packet"
Output: {"action":"purchase","productName":"Biscuit","quantity":20,"unit":"packet","costPrice":30,"salePrice":null,"category":null,"status":null,"period":null,"confidence":"high"}
}
`;

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcribedText },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 300,
  });

  const raw = response.choices[0].message.content;
  return JSON.parse(raw);
};

// ── Text → Speech (ElevenLabs) ─────────────────────────────────────────
const textToSpeech = async (text) => {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs TTS error: ${response.status} - ${err}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};


app.get("/",(req,res)=>{
    res.render("index.html");
});
app.get("/admin_panel",IsloggedIn,(req,res)=>{
  const username = req.user.username;
    res.render("home1.ejs",{username});
});
app.get("/login",(req,res)=>{
    res.render("login.ejs");
});
app.get("/register",(req,res)=>{
    res.render("signup.ejs");
});


// app.post(
//   "/voice-command",
//   upload.single("audio"),
//   async (req, res) => {

//     const filePath = req.file.path;

//     const text = await transcribeAudio(filePath);

//     console.log("Transcript:", text);

//     const intent = await parseIntent(text);

//     console.log(intent);

//     res.json({
//       transcript: text,
//       intent
//     });
// });


app.post(
  "/voice-command",
  upload.single("audio"),IsloggedIn,
  async (req, res) => {

    try {

      const transcript =
        await transcribeAudio(req.file.path);



        // / ✅ Delete temp file after transcription
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("Failed to delete temp file:", err);
      });
      const intent =
        await parseIntent(transcript);

      const message =
        await handleIntent(intent, req.user?._id);

      const audioBuffer =
        await textToSpeech(message);

      res.json({
        success: true,
        transcript,
        intent,
        message,
        audio: audioBuffer.toString("base64")
      });

    } catch(err) {

      console.error(err);

      res.status(500).json({
        success:false,
        error: err.message
      });
    }
});



async function handleIntent(intent, userId) {
  switch (intent.action) {
    case "add":       return await addProduct(intent, userId);
    case "update":    return await updateProduct(intent, userId);
    case "delete":    return await deleteProduct(intent, userId);
    case "sale":      return await recordSale(intent, userId);
    case "purchase":  return await recordPurchase(intent, userId);
    case "check":     return await checkStock(intent, userId);
    case "report":    return await generateReport(intent, userId);
    case "all_stock": return await getAllStock(userId);
    case "low_stock": return await getLowStock(intent, userId);
    case "unknown":   return `Yeh command samajh nahi aayi. Dobara bolein.`;
    default:          return `Invalid action.`;
  }
}


// ─────────────────────────────────────────
// 1. ADD PRODUCT
// ─────────────────────────────────────────
async function addProduct(intent, userId) {
  const product = await Product.create({
    userId,
    name:      intent.productName,
    category:  intent.category  || "General",
    quantity:  intent.quantity  || 0,
    unit:      intent.unit      || "pcs",
    costPrice: intent.costPrice || 0,
    salePrice: intent.salePrice || 0,
    status:    "not-sold"  , // always not-sold on add
    userId: userId
  });

  return `"${product.name}" inventory mein add ho gaya.`;
}

// ─────────────────────────────────────────
// 2. UPDATE PRODUCT
// ─────────────────────────────────────────
async function updateProduct(intent, userId) {
  const product = await Product.findOne({
    userId,
    name: { $regex: new RegExp(`^${intent.productName}$`, "i") }
  });

  if (!product) return `${intent.productName} nahi mila.`;

  // Only update fields that were actually mentioned (not null)
  if (intent.quantity  !== null) product.quantity  = intent.quantity;
  if (intent.costPrice !== null) product.costPrice = intent.costPrice;
  if (intent.salePrice !== null) product.salePrice = intent.salePrice;
  if (intent.unit      !== null) product.unit      = intent.unit;
  if (intent.category  !== null) product.category  = intent.category;
  if (intent.status    !== null) product.status    = intent.status;

  await product.save();

  return `"${product.name}" update ho gaya.`;
}

// ─────────────────────────────────────────
// 3. DELETE PRODUCT
// ─────────────────────────────────────────
async function deleteProduct(intent, userId) {
  const product = await Product.findOneAndDelete({
    userId,
    name: { $regex: new RegExp(`^${intent.productName}$`, "i") }
  });

  if (!product) return `${intent.productName} nahi mila.`;

  return `"${product.name}" inventory se delete ho gaya.`;
}

// ─────────────────────────────────────────
// 4. RECORD SALE  (inserts new "sold" record)
// ─────────────────────────────────────────
async function recordSale(intent, userId) {
  // Check if product exists at all
  const existing = await Product.findOne({
    userId,
    name: { $regex: new RegExp(`^${intent.productName}$`, "i") }
  });

  if (!existing) return `${intent.productName} inventory mein nahi hai.`;

  // Calculate net stock before allowing sale
  const added = await Product.aggregate([
    { $match: { userId, name: existing.name, status: { $ne: "sold" } } },
    { $group: { _id: null, total: { $sum: "$quantity" } } }
  ]);
  const sold = await Product.aggregate([
    { $match: { userId, name: existing.name, status: "sold" } },
    { $group: { _id: null, total: { $sum: "$quantity" } } }
  ]);

  const totalAdded = added[0]?.total || 0;
  const totalSold  = sold[0]?.total  || 0;
  const netStock   = totalAdded - totalSold;

  if (intent.quantity > netStock) {
    return `Sirf ${netStock} ${existing.unit} bacha hai, itna sell nahi kar sakte.`;
  }

  // Insert a new sold record (ledger style)
  await Product.create({
    userId,
    name:      existing.name,
    category:  existing.category,
    quantity:  intent.quantity,
    unit:      existing.unit,
    costPrice: existing.costPrice,
    salePrice: intent.salePrice || existing.salePrice,
    status:    "sold"
  });

  return `${intent.quantity} ${existing.unit} "${existing.name}" sold ho gaya. Bacha hua stock: ${netStock - intent.quantity} ${existing.unit}.`;
}

// ─────────────────────────────────────────
// 5. RECORD PURCHASE  (inserts new "not_selling" record = restock)
// ─────────────────────────────────────────
async function recordPurchase(intent, userId) {
  const existing = await Product.findOne({
    userId,
    name: { $regex: new RegExp(`^${intent.productName}$`, "i") }
  });

  if (!existing) return `${intent.productName} pehle se inventory mein nahi. Pehle add karein.`;

  await Product.create({
    userId,
    name:      existing.name,
    category:  existing.category,
    quantity:  intent.quantity,
    unit:      existing.unit,
    costPrice: intent.costPrice || existing.costPrice,
    salePrice: existing.salePrice,
    status:    "not-sold"   // new stock, not listed yet
  });

  return `${intent.quantity} ${existing.unit} "${existing.name}" ka naya stock add ho gaya.`;
}
async function getAllStock(userId) {
  const stocks = await Product.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: "$name",
        totalAdded: { $sum: { $cond: [{ $ne: ["$status", "sold"] }, "$quantity", 0] } },
        totalSold:  { $sum: { $cond: [{ $eq: ["$status", "sold"] }, "$quantity", 0] } },
        unit:       { $first: "$unit" },
        category:   { $first: "$category" }
      }
    },
    {
      $project: {
        name:         "$_id",
        unit:         1,
        category:     1,
        currentStock: { $subtract: ["$totalAdded", "$totalSold"] }
      }
    },
    { $sort: { name: 1 } }
  ]);

  if (!stocks.length) return `Abhi koi product inventory mein nahi hai.`;

  let result = `📦 Poora Stock:\n`;
  for (const item of stocks) {
    result += `• ${item.name}: ${item.currentStock} ${item.unit}\n`;
  }

  return result;
}
// ─────────────────────────────────────────
// 6. CHECK STOCK
// ─────────────────────────────────────────
async function checkStock(intent, userId) {
  const name = intent.productName;

  const added = await Product.aggregate([
    { $match: { userId, name: { $regex: new RegExp(`^${name}$`, "i") }, status: { $ne: "sold" } } },
    { $group: { _id: null, total: { $sum: "$quantity" }, unit: { $first: "$unit" } } }
  ]);
  const sold = await Product.aggregate([
    { $match: { userId, name: { $regex: new RegExp(`^${name}$`, "i") }, status: "sold" } },
    { $group: { _id: null, total: { $sum: "$quantity" } } }
  ]);

  if (!added[0]) return `${name} inventory mein nahi mila.`;

  const totalAdded = added[0].total;
  const totalSold  = sold[0]?.total || 0;
  const netStock   = totalAdded - totalSold;
  const unit       = added[0].unit;

  return `"${name}": Total aaya ${totalAdded} ${unit}, bika ${totalSold} ${unit}, bacha hua ${netStock} ${unit}.`;
}

// ─────────────────────────────────────────
// 7. GENERATE REPORT
// ─────────────────────────────────────────
async function generateReport(intent, userId) {
  const now = new Date();
  let startDate;

  if (intent.period === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (intent.period === "week") {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 7);
  } else if (intent.period === "month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1); // default: this month
  }

  const report = await Product.aggregate([
    {
      $match: {
        userId,
        createdAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: { name: "$name", status: "$status" },
        totalQty:     { $sum: "$quantity" },
        totalRevenue: { $sum: { $multiply: ["$quantity", "$salePrice"] } }
      }
    },
    { $sort: { "_id.name": 1 } }
  ]);

  if (!report.length) return `Is period mein koi record nahi mila.`;

  // Format into readable summary
  const summary = {};
  for (const row of report) {
    const name   = row._id.name;
    const status = row._id.status;
    if (!summary[name]) summary[name] = { added: 0, sold: 0, revenue: 0 };
    if (status === "sold")        { summary[name].sold    += row.totalQty; summary[name].revenue += row.totalRevenue; }
    if (status !== "sold")        { summary[name].added   += row.totalQty; }
  }

  let result = `📊 Report (${intent.period || "month"}):\n`;
  for (const [name, data] of Object.entries(summary)) {
    result += `• ${name}: Aaya ${data.added}, Bika ${data.sold}, Kamai Rs.${data.revenue}\n`;
  }

  return result;
}

// ─────────────────────────────────────────
// 8. GET LOW STOCK
// ─────────────────────────────────────────
async function getLowStock(intent, userId) {
  const THRESHOLD = 10; // you can make this per-product later

  const stocks = await Product.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: "$name",
        totalAdded: { $sum: { $cond: [{ $ne: ["$status", "sold"] }, "$quantity", 0] } },
        totalSold:  { $sum: { $cond: [{ $eq: ["$status", "sold"] }, "$quantity", 0] } },
        unit:       { $first: "$unit" }
      }
    },
    {
      $project: {
        name:         "$_id",
        unit:         1,
        currentStock: { $subtract: ["$totalAdded", "$totalSold"] }
      }
    },
    { $match: { currentStock: { $lte: THRESHOLD } } },
    { $sort: { currentStock: 1 } }
  ]);

  if (!stocks.length) return `Sab products ka stock theek hai.`;

  let result = `⚠️ Yeh products khatam ho rahe hain:\n`;
  for (const item of stocks) {
    result += `• ${item.name}: sirf ${item.currentStock} ${item.unit} bachi hai\n`;
  }

  return result;
}

// ─────────────────────────────────────────
// MAIN DISPATCHER
// ─────────────────────────────────────────


app.post('/register', async (req, res, next) => {

    const {username,email,password} = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: 'Username, email and password are required.' });
    }

  
const user=await User.register(new User({ username, email}), password);  
console.log("User registered:", user);
    // Log the user in right after registering — establishes the session
    // and sets the "connect.sid" cookie on the response automatically.
   res.send("Registration successful. You can now log in.");
 
});

// POST /api/auth/login
app.post("/login", passport.authenticate("local"), (req, res) => {
  const username = req.user.username;
  res.render("home1.ejs", { username });
});


// POST /api/auth/logout
app.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true, message: 'Logged out successfully.' });
    });
  });
});

// GET /api/auth/me


// ════════════════════════════════════════════════════════════════════════
// 8. INVENTORY ROUTES — /api/inventory   (now guarded by session middleware)
// ════════════════════════════════════════════════════════════════════════



// GET /api/inventory/products
app.get('/products', async (req, res) => {
  try {
    const products = await Product.find({ userId: req.user._id }).sort({ name: 1 });
    res.json({
      success: true,
      count: products.length,
      data: products.map((p) => ({
        id: p._id,
        name: p.name,
        category: p.category,
        quantity: p.quantity,
        unit: p.unit,
        costPrice: p.costPrice,
        salePrice: p.salePrice,
        status: p.status,
        lowStockThreshold: p.lowStockThreshold,
        dateAdded: p.dateAdded,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/inventory/products
app.post('/products', async (req, res) => {
  try {
    const { name, category, quantity, unit, costPrice, salePrice, status, lowStockThreshold } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Product name is required.' });
    }

    const exists = await Product.findOne({
      userId: req.user._id,
      name: { $regex: new RegExp(`^${name}$`, 'i') },
    });
    if (exists) {
      return res.status(400).json({ success: false, message: `"${name}" already exists. Use update to change quantity.` });
    }

    const product = await Product.create({
      userId: req.user._id,
      name,
      category: category || 'General',
      quantity: quantity || 0,
      unit: unit || 'pcs',
      costPrice: costPrice || 0,
      salePrice: salePrice || 0,
      status: status || 'sold',
      lowStockThreshold: lowStockThreshold || 5,
    });

 

    res.status(201).json({ success: true, message: `"${name}" added to inventory.`, data: product });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});



// ─────────────────────────────────────────
// ANALYTICS ROUTE
// Add this to your existing app.js (before the app.listen at the bottom)
// ─────────────────────────────────────────

app.get("/analytics", IsloggedIn, async (req, res) => {
  try {
    const userId = req.user._id;
    const now = new Date();

    // ── 1. Daily Revenue vs Profit — last 30 days ──────────────────────
    // Revenue  = sold records → quantity × salePrice
    // Profit   = revenue − (quantity × costPrice)
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const dailyData = await Product.aggregate([
      {
        $match: {
          userId,
          status: "sold",
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          revenue: { $sum: { $multiply: ["$quantity", "$salePrice"] } },
          cogs:    { $sum: { $multiply: ["$quantity", "$costPrice"] } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          date:    "$_id",
          revenue: { $round: ["$revenue", 0] },
          profit:  { $round: [{ $subtract: ["$revenue", "$cogs"] }, 0] },
          _id:     0,
        },
      },
    ]);

    const revenueLabels = dailyData.map((d) => d.date);
    const revenueValues = dailyData.map((d) => d.revenue);
    const profitValues  = dailyData.map((d) => d.profit);

    // ── 2. Monthly Comparison ──────────────────────────────────────────
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [thisMonthAgg, lastMonthAgg] = await Promise.all([
      Product.aggregate([
        {
          $match: {
            userId,
            status: "sold",
            createdAt: { $gte: thisMonthStart },
          },
        },
        {
          $group: {
            _id:   null,
            total: { $sum: { $multiply: ["$quantity", "$salePrice"] } },
          },
        },
      ]),
      Product.aggregate([
        {
          $match: {
            userId,
            status: "sold",
            createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd },
          },
        },
        {
          $group: {
            _id:   null,
            total: { $sum: { $multiply: ["$quantity", "$salePrice"] } },
          },
        },
      ]),
    ]);

    const thisMonthSales = Math.round(thisMonthAgg[0]?.total || 0);
    const lastMonthSales = Math.round(lastMonthAgg[0]?.total || 0);

    const monthNames = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December",
    ];
    const thisMonthName = monthNames[now.getMonth()];
    const lastMonthName = monthNames[now.getMonth() === 0 ? 11 : now.getMonth() - 1];

    // ── 3. Gross Profit / COGS / Wastage Donut ────────────────────────
    // Since your model has no wastage field, wastage = 0
    // Gross Profit = total revenue − total COGS
    const allTimeSales = await Product.aggregate([
      { $match: { userId, status: "sold" } },
      {
        $group: {
          _id:          null,
          totalRevenue: { $sum: { $multiply: ["$quantity", "$salePrice"] } },
          totalCOGS:    { $sum: { $multiply: ["$quantity", "$costPrice"] } },
        },
      },
    ]);

    const totalRevenue  = Math.round(allTimeSales[0]?.totalRevenue || 0);
    const totalCOGS     = Math.round(allTimeSales[0]?.totalCOGS    || 0);
    const grossProfit   = Math.max(0, totalRevenue - totalCOGS);

    const donutLabels = ["Gross Profit", "COGS"];
    const donutValues = [grossProfit, totalCOGS];

    // ── 4. Low Stock — using your same ledger aggregation ─────────────
    // Mirrors your getLowStock() function exactly
    const THRESHOLD = 10;

    const lowStockRaw = await Product.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id:        "$name",
          totalAdded: {
            $sum: { $cond: [{ $ne: ["$status", "sold"] }, "$quantity", 0] },
          },
          totalSold: {
            $sum: { $cond: [{ $eq: ["$status", "sold"] }, "$quantity", 0] },
          },
          unit: { $first: "$unit" },
        },
      },
      {
        $project: {
          name:         "$_id",
          unit:         1,
          currentStock: { $subtract: ["$totalAdded", "$totalSold"] },
        },
      },
      { $match: { currentStock: { $gte: 0, $lte: THRESHOLD } } },
      { $sort:  { currentStock: 1 } },
      { $limit: 10 },
    ]);

    const lowStockNames     = lowStockRaw.map((p) => p.name);
    const lowStockQty       = lowStockRaw.map((p) => p.currentStock);
    const lowStockThreshold = lowStockRaw.map(() => THRESHOLD); // same threshold for all

    // ── 5. Top 5 Selling Products by Quantity ─────────────────────────
    const topProducts = await Product.aggregate([
      { $match: { userId, status: "sold" } },
      {
        $group: {
          _id:      "$name",
          totalQty: { $sum: "$quantity" },
        },
      },
      { $sort:  { totalQty: -1 } },
      { $limit: 5 },
      {
        $project: {
          name: "$_id",
          qty:  "$totalQty",
          _id:  0,
        },
      },
    ]);

    const topProductNames = topProducts.map((p) => p.name);
    const topProductQty   = topProducts.map((p) => p.qty);

    // ── Render ─────────────────────────────────────────────────────────
    res.render("analytics", {
      username: req.user.username,

      // Chart 1
      revenueLabels: JSON.stringify(revenueLabels),
      revenueValues: JSON.stringify(revenueValues),
      profitValues:  JSON.stringify(profitValues),

      // Chart 2
      thisMonthName,
      lastMonthName,
      thisMonthSales,
      lastMonthSales,

      // Chart 3
      donutLabels: JSON.stringify(donutLabels),
      donutValues: JSON.stringify(donutValues),

      // Chart 4
      lowStockNames:     JSON.stringify(lowStockNames),
      lowStockQty:       JSON.stringify(lowStockQty),
      lowStockThreshold: JSON.stringify(lowStockThreshold),
      hasLowStock:       lowStockRaw.length > 0,

      // Chart 5
      topProductNames: JSON.stringify(topProductNames),
      topProductQty:   JSON.stringify(topProductQty),
    });

  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).send("Server Error");
  }
});










if (process.env.NODE_ENV !== 'production') {
  app.listen(3000);
}
module.exports = app;
