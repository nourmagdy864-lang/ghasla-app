// db.js — تخزين البيانات: ملف JSON محلي بشكل افتراضي، أو MongoDB لو حددت MONGODB_URI
// (لو بتشغل السيرفر محليًا من غير أي إعداد، هيستخدم data/db.json تلقائي زي الأول)

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const MONGODB_URI = process.env.MONGODB_URI || '';

function generateEmployees(count) {
  const employees = [];
  const prefix = '012111'; // البادئة الثابتة، وبعدها رقم الموظف نفسه بالظبط
  for (let i = 1; i <= count; i++) {
    const code = prefix + i; // لمعة 1 → 0121111، لمعة 50 → 01211150، لمعة 100 → 012111100
    employees.push({
      id: 'emp_' + i,
      branchId: 'br_maadi',
      name: 'لمعة ' + i,
      pinHash: hashPin(code)
    });
  }
  return employees;
}

function defaultData() {
  return {
    branches: [
      { id: 'br_maadi', name: 'فرع المعادي', address: '' },
      { id: 'br_nasr', name: 'فرع مدينة نصر', address: '' }
    ],
    employees: generateEmployees(100), // من 0121111 لحد 0121210
    admins: [
      // حساب الأدمن (المالك) — صلاحيات كاملة، بيدخل برقمه بس زي الموظفين
      { id: 'admin_1', name: 'نور', codeHash: hashPin('nour86633') }
    ],
    customers: [],
    rewards: [
      // employeeIds: [] معناها الخدمة دي متاحة لعملاء كل الموظفين، أو تقدر تخصصها لموظف أو أكتر
      { id: 'rw_1', employeeIds: [], name: 'غسلة عادية', cost: 50 },
      { id: 'rw_2', employeeIds: [], name: 'غسلة كماوي قطعة', cost: 100 },
      { id: 'rw_3', employeeIds: [], name: 'غسلة كماوي موتور', cost: 70 },
      { id: 'rw_4', employeeIds: [], name: 'خصم 25%', cost: 100 },
      { id: 'rw_5', employeeIds: [], name: 'خصم منتج 25%', cost: 150 },
      { id: 'rw_6', employeeIds: [], name: 'خصم 300 جنيه على الغسلة الكماوي الكامل', cost: 200 }
    ],
    transactions: [],
    messages: [],
    settings: {
      siteName: 'غسلة',
      tagline: 'كل غسلة... تقرّبك خطوة من مكافأتك الجاية',
      accentColor: '#0B72D9',
      accentBright: '#29A8E0',
      qrLogoSize: 'medium', // small | medium | large
      qrLogoPosition: 'top' // top | corner
    },
    sessions: {}
  };
}

const crypto = require('crypto');
function hashPin(pin) {
  const salt = crypto.randomBytes(8).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

let cache = null;
let mongoCollection = null;

function loadFromDisk() {
  if (!fs.existsSync(DB_PATH)) {
    cache = defaultData();
    saveToDisk(cache);
    return;
  }
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (err) {
    console.error('تعذر قراءة قاعدة البيانات، هيتم إنشاء واحدة جديدة:', err.message);
    cache = defaultData();
    saveToDisk(cache);
  }
}

function saveToDisk(data) {
  cache = data;
  // كتابة atomic: بنكتب في ملف مؤقت وبعدين نستبدل، عشان مفيش داتا تتلف لو السيرفر اتقفل وهو بيكتب
  const tmpPath = DB_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, DB_PATH);
}

async function loadFromMongo() {
  const doc = await mongoCollection.findOne({ _id: 'main' });
  if (doc) {
    delete doc._id;
    cache = doc;
  } else {
    cache = defaultData();
    await mongoCollection.updateOne({ _id: 'main' }, { $set: cache }, { upsert: true });
  }
}

// لازم تتنادى مرة واحدة (await) قبل ما السيرفر يبدأ يستقبل طلبات
async function init() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    mongoCollection = client.db('ghasla').collection('appdata');
    await loadFromMongo();
    console.log('📦 البيانات متخزنة على MongoDB (تخزين دائم)');
  } else {
    loadFromDisk();
    console.log('📦 البيانات متخزنة في ملف محلي (data/db.json)');
  }
}

function get() {
  if (!cache) loadFromDisk(); // شبكة أمان لو حد نادى get() قبل init() في وضع الملف المحلي
  return cache;
}

function persist() {
  if (mongoCollection) {
    // بنحفظ في الخلفية من غير ما نوقف الرد على المستخدم
    mongoCollection.updateOne({ _id: 'main' }, { $set: cache }, { upsert: true })
      .catch(err => console.error('تعذر الحفظ على MongoDB:', err.message));
  } else {
    saveToDisk(cache);
  }
}

module.exports = { init, get, persist, hashPin };
