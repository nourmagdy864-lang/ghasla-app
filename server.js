// server.js — سيرفر "لمعة" الكامل
// من غير أي مكتبات خارجية (zero dependencies) — يشتغل بأمر واحد: node server.js
// بيخدم الموقع (public/) وبيوفر الـ API لتسجيل العملاء، الغسلات، والاستبدال.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./src/db');
const auth = require('./src/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- أدوات مساعدة ----------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4e6) { req.destroy(); reject(new Error('الطلب كبير جدًا')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('صيغة الطلب غير صحيحة'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      // لو مفيش ملف بالظبط، رجّع صفحة 404 بسيطة
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1 style="font-family:sans-serif">404 — الصفحة مش موجودة</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function requireCustomer(req) {
  const token = auth.getTokenFromReq(req);
  const session = auth.getSession(token);
  if (!session || session.role !== 'customer') return null;
  return session;
}

function requireEmployee(req) {
  const token = auth.getTokenFromReq(req);
  const session = auth.getSession(token);
  if (!session || session.role !== 'employee') return null;
  return session;
}

function publicCustomer(c) {
  return { id: c.id, name: c.name, phone: c.phone, plateNumber: c.plateNumber || null, points: c.points, claimed: !!c.passwordHash, note: c.note || '' };
}

// ---------- المسارات (API Routes) ----------

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

// --- إعدادات الموقع: أي حد يقدر يقراها (اسم الموقع، الألوان...)، الأدمن بس يقدر يعدلها ---
route('GET', '/api/settings', async (req, res) => {
  const data = db.get();
  sendJSON(res, 200, { settings: data.settings });
});

route('POST', '/api/admin/settings', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const body = await readBody(req);
  const data = db.get();
  const allowedKeys = ['siteName', 'tagline', 'accentColor', 'accentBright', 'qrLogoSize', 'qrLogoPosition'];
  allowedKeys.forEach(k => {
    if (typeof body[k] === 'string' && body[k].trim()) data.settings[k] = body[k].trim();
  });
  db.persist();
  sendJSON(res, 200, { settings: data.settings });
});


function normalizePlate(plate) {
  return String(plate || '').trim().replace(/\s+/g, '').toUpperCase();
}

// --- تسجيل عميل جديد (لو الرقم متسجل قبل كده من موظف بس لسه ملوش باسورد، بيفعّل الحساب) ---
route('POST', '/api/auth/signup', async (req, res) => {
  const { name, phone, password, plateNumber, refEmp } = await readBody(req);
  if (!name || !phone || !password || password.length < 4) {
    return sendJSON(res, 400, { error: 'الاسم والرقم وكلمة مرور 4 حروف/أرقام على الأقل مطلوبين' });
  }
  if (!plateNumber || !normalizePlate(plateNumber)) {
    return sendJSON(res, 400, { error: 'رقم لوحة العربية مطلوب' });
  }
  const normalizedPlate = normalizePlate(plateNumber);
  const data = db.get();
  let customer = data.customers.find(c => c.phone === phone);

  if (customer && customer.passwordHash) {
    return sendJSON(res, 409, { error: 'الرقم ده متسجل بحساب قبل كده، جرب تسجل الدخول' });
  }

  // منع تكرار نفس رقم اللوحة على حساب مختلف — سواء بيفعّل حساب جديد أو حساب قديم من زيارة موظف
  const plateOwner = data.customers.find(c =>
    c.plateNumber && normalizePlate(c.plateNumber) === normalizedPlate && c.phone !== phone
  );
  if (plateOwner) {
    return sendJSON(res, 409, { error: 'رقم اللوحة ده مسجل بالفعل على حساب تاني' });
  }

  // لو جاي من كود QR بتاع موظف معين، نسجل مين "صاحب" العميل ده — مرة واحدة بس، مش بتتغير بعد كده
  const referringEmployee = refEmp ? data.employees.find(e => e.id === refEmp) : null;

  if (customer) {
    // العميل ده كان مسجّل بواسطة موظف (زيارة سابقة) ولسه ملوش باسورد — دلوقتي بيفعّل حسابه
    customer.name = name;
    customer.passwordHash = auth.hashPassword(password);
    customer.plateNumber = plateNumber.trim();
    if (referringEmployee && !customer.ownerEmployeeId) {
      customer.ownerEmployeeId = referringEmployee.id;
    }
  } else {
    customer = {
      id: 'cus_' + crypto.randomBytes(6).toString('hex'),
      name, phone,
      plateNumber: plateNumber.trim(),
      passwordHash: auth.hashPassword(password),
      points: 0,
      lastBonusDate: null,
      ownerEmployeeId: referringEmployee ? referringEmployee.id : null,
      createdAt: Date.now()
    };
    data.customers.push(customer);
  }
  db.persist();
  const token = auth.createSession(customer.id, 'customer');
  sendJSON(res, 200, { token, customer: publicCustomer(customer) });
});

route('POST', '/api/auth/login', async (req, res) => {
  const { phone, password } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.phone === phone);
  if (!customer || !auth.verifyPassword(password, customer.passwordHash)) {
    return sendJSON(res, 401, { error: 'رقم الهاتف أو كلمة المرور غلط' });
  }
  const token = auth.createSession(customer.id, 'customer');
  sendJSON(res, 200, { token, customer: publicCustomer(customer) });
});

route('GET', '/api/me', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول' });
  const data = db.get();
  const customer = data.customers.find(c => c.id === session.userId);
  if (!customer) return sendJSON(res, 404, { error: 'الحساب مش موجود' });
  let myEmployee = null;
  if (customer.ownerEmployeeId) {
    const emp = data.employees.find(e => e.id === customer.ownerEmployeeId);
    if (emp) {
      const branch = data.branches.find(b => b.id === emp.branchId);
      myEmployee = {
        name: emp.name, phone: emp.phone || null, address: emp.address || null,
        photoUrl: emp.photoUrl || null, branchName: branch ? branch.name : null
      };
    }
  }
  sendJSON(res, 200, { customer: publicCustomer(customer), myEmployee });
});

route('GET', '/api/activity', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول' });
  const data = db.get();
  const items = data.transactions
    .filter(t => t.customerId === session.userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 15);
  sendJSON(res, 200, { items });
});

route('GET', '/api/rewards', async (req, res) => {
  const data = db.get();
  sendJSON(res, 200, { rewards: data.rewards });
});

// --- قائمة عامة بأسماء وصور الموظفين (لخريطة/دليل الفريق في صفحة العميل) ---
route('GET', '/api/employees-public', async (req, res) => {
  const data = db.get();
  const employees = data.employees.map(e => {
    const branch = data.branches.find(b => b.id === e.branchId);
    return { id: e.id, name: e.name, photoUrl: e.photoUrl || null, branchName: branch ? branch.name : '' };
  });
  sendJSON(res, 200, { employees });
});

// --- الخدمات المتاحة للعميل: العامة + الخاصة بالموظف اللي هو تابعه ---
route('GET', '/api/customer/rewards', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول' });
  const data = db.get();
  const customer = data.customers.find(c => c.id === session.userId);
  const rewards = data.rewards.filter(r => !r.employeeIds || !r.employeeIds.length || (customer && r.employeeIds.includes(customer.ownerEmployeeId)));
  sendJSON(res, 200, { rewards });
});

// --- الخدمات المتاحة للموظف يستبدلها لعميله (العامة + الخاصة بيه) ---
route('GET', '/api/employee/rewards', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const data = db.get();
  const rewards = data.rewards.filter(r => !r.employeeIds || !r.employeeIds.length || r.employeeIds.includes(session.userId));
  sendJSON(res, 200, { rewards });
});

const WELCOME_BONUS_POINTS = 10;

function todayCairo() {
  // بنستخدم توقيت القاهرة عشان "اليوم" يتغير في نفس التوقيت اللي المحل شغال بيه
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

// --- استبدال كود QR: 10 نقاط كحد أقصى في اليوم الواحد، مهما اتمسح الكود عدد مرات في نفس اليوم ---
// --- عميل عنده حساب بالفعل مسح كود موظف: يتسجل تحت الموظف ده لو مش تابع لحد قبل كده ---
route('POST', '/api/customer/assign-employee', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول' });
  const { employeeId } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.id === session.userId);
  if (!customer) return sendJSON(res, 404, { error: 'الحساب مش موجود' });
  const employee = data.employees.find(e => e.id === employeeId);
  if (!employee) return sendJSON(res, 404, { error: 'الموظف مش موجود' });
  if (customer.ownerEmployeeId) {
    // العميل ده تابع لموظف قبل كده، مش هنغيره حتى لو مسح كود موظف تاني
    return sendJSON(res, 200, { customer: publicCustomer(customer), assigned: false });
  }
  customer.ownerEmployeeId = employee.id;
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer), assigned: true });
});

route('POST', '/api/customer/claim-bonus', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول الأول عشان تاخد النقاط' });
  const data = db.get();
  const customer = data.customers.find(c => c.id === session.userId);
  if (!customer) return sendJSON(res, 404, { error: 'الحساب مش موجود' });

  const today = todayCairo();

  if (customer.lastBonusDate === today) {
    return sendJSON(res, 200, {
      alreadyClaimed: true,
      customer: publicCustomer(customer),
      message: 'أخدت أقصى نقاط ممكنة من الكود ده النهاردة، تعال بكرة تاخد 10 تانية'
    });
  }

  customer.points += WELCOME_BONUS_POINTS;
  customer.lastBonusDate = today;
  data.transactions.push({
    id: 'tx_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id,
    type: 'earn',
    amount: WELCOME_BONUS_POINTS,
    desc: 'هدية يومية — مسح كود QR',
    createdAt: Date.now()
  });
  db.persist();
  sendJSON(res, 200, {
    alreadyClaimed: false,
    customer: publicCustomer(customer),
    message: `مبروك! أضفنالك ${WELCOME_BONUS_POINTS} نقاط هدية النهاردة`
  });
});

route('POST', '/api/redeem', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول' });
  const { rewardId } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.id === session.userId);
  const reward = data.rewards.find(r => r.id === rewardId);
  if (!reward) return sendJSON(res, 404, { error: 'المكافأة دي مش موجودة' });
  if (reward.employeeIds && reward.employeeIds.length && !reward.employeeIds.includes(customer.ownerEmployeeId)) {
    return sendJSON(res, 403, { error: 'الخدمة دي مش متاحة لحسابك' });
  }
  if (customer.points < reward.cost) return sendJSON(res, 400, { error: 'رصيدك مش كافي للمكافأة دي' });

  customer.points -= reward.cost;
  data.transactions.push({
    id: 'tx_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id,
    type: 'redeem',
    amount: -reward.cost,
    desc: `استبدال: ${reward.name}`,
    createdAt: Date.now()
  });
  db.persist();

  // إحصائيات وجاهزة لرسالة شكر واتساب (الإرسال بيدوي يدويًا من الموظف/الأدمن)
  const custTxs = data.transactions.filter(t => t.customerId === customer.id);
  const visits = custTxs.filter(t => t.type === 'earn').length;
  const totalEarned = custTxs.filter(t => t.type === 'earn').reduce((s, t) => s + t.amount, 0);
  const thankYouMessage = `شكرًا يا ${customer.name} لاستخدامك خدمة "${reward.name}"! 🚗✨ لحد دلوقتي استخدمت ${totalEarned.toLocaleString('en-US')} نقطة في ${visits} زيارة معانا. كمّل تجمع نقط أكتر عشان توصل لمكافأتك الجاية أسرع 💛`;

  sendJSON(res, 200, {
    customer: publicCustomer(customer),
    message: `تم استبدال "${reward.name}" بنجاح`,
    whatsapp: { phone: customer.phone, text: thankYouMessage }
  });
});

// --- الموظف يبعت رسالة لعميله (بتظهر باسمه هو) ---
route('POST', '/api/employee/message', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const { phone, text } = await readBody(req);
  if (!text || !text.trim()) return sendJSON(res, 400, { error: 'اكتب نص الرسالة' });
  const data = db.get();
  const employee = data.employees.find(e => e.id === session.userId);
  const customer = data.customers.find(c => c.phone === phone);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  if (customer.ownerEmployeeId && customer.ownerEmployeeId !== session.userId) {
    return sendJSON(res, 403, { error: 'العميل ده مش تابع لك، مينفعش تبعتله رسالة' });
  }
  const message = {
    id: 'msg_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id,
    senderName: employee.name,
    text: text.trim(),
    createdAt: Date.now()
  };
  data.messages.push(message);
  db.persist();
  sendJSON(res, 200, { message });
});

// --- الأدمن يبعت رسالة لأي عميل (بتظهر دايمًا باسم "لمعة") ---
route('POST', '/api/admin/message', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { customerId, text } = await readBody(req);
  if (!text || !text.trim()) return sendJSON(res, 400, { error: 'اكتب نص الرسالة' });
  const data = db.get();
  const customer = data.customers.find(c => c.id === customerId);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  const message = {
    id: 'msg_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id,
    senderName: data.settings.siteName,
    text: text.trim(),
    createdAt: Date.now()
  };
  data.messages.push(message);
  db.persist();
  sendJSON(res, 200, { message });
});

// --- رسائل العميل (خانة الإشعارات جوّه حسابه) ---
route('GET', '/api/customer/messages', async (req, res) => {
  const session = requireCustomer(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول' });
  const data = db.get();
  const messages = data.messages
    .filter(m => m.customerId === session.userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  sendJSON(res, 200, { messages });
});


route('POST', '/api/employee/login', async (req, res) => {
  const { code } = await readBody(req);
  if (!code) return sendJSON(res, 400, { error: 'اكتب الرقم بتاعك' });
  const data = db.get();
  const employee = data.employees.find(e => auth.verifyPin(code, e.pinHash));
  if (!employee) return sendJSON(res, 401, { error: 'الرقم غلط' });
  const branch = data.branches.find(b => b.id === employee.branchId);
  const token = auth.createSession(employee.id, 'employee', { branchId: employee.branchId });
  sendJSON(res, 200, {
    token,
    employee: { name: employee.name },
    branch: branch ? { id: branch.id, name: branch.name } : null
  });
});

// --- دخول الأدمن: رقم واحد بصلاحيات كاملة على كل الفروع والموظفين والعملاء ---
route('POST', '/api/admin/login', async (req, res) => {
  const { code } = await readBody(req);
  if (!code) return sendJSON(res, 400, { error: 'اكتب الرقم بتاعك' });
  const data = db.get();
  const admin = (data.admins || []).find(a => auth.verifyPin(code, a.codeHash));
  if (!admin) return sendJSON(res, 401, { error: 'الرقم غلط' });
  const token = auth.createSession(admin.id, 'admin');
  sendJSON(res, 200, { token, admin: { name: admin.name } });
});

function requireAdmin(req) {
  const token = auth.getTokenFromReq(req);
  const session = auth.getSession(token);
  if (!session || session.role !== 'admin') return null;
  return session;
}

// --- الأدمن: كل العملاء وأرصدتهم ---
route('GET', '/api/admin/customers', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const data = db.get();
  const customers = data.customers
    .map(c => {
      const emp = c.ownerEmployeeId ? data.employees.find(e => e.id === c.ownerEmployeeId) : null;
      return { ...publicCustomer(c), ownerName: emp ? emp.name : null, ownerEmployeeId: c.ownerEmployeeId || null };
    })
    .sort((a, b) => b.points - a.points);
  sendJSON(res, 200, { customers });
});

// --- الأدمن: كل الموظفين وفروعهم وصورهم وعدد عملاء كل واحد ---
route('GET', '/api/admin/employees', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const data = db.get();
  const employees = data.employees.map(e => {
    const branch = data.branches.find(b => b.id === e.branchId);
    const customerCount = data.customers.filter(c => c.ownerEmployeeId === e.id).length;
    return {
      id: e.id, name: e.name, phone: e.phone || null, address: e.address || null,
      photoUrl: e.photoUrl || null, branchId: e.branchId, branchName: branch ? branch.name : '—', customerCount,
      qrColor: e.qrColor || null, qrBgColor: e.qrBgColor || null, qrLogoUrl: e.qrLogoUrl || null,
      qrTemplate: e.qrTemplate || null, qrLogoScale: e.qrLogoScale || null,
      qrLogoX: typeof e.qrLogoX === 'number' ? e.qrLogoX : null, qrLogoY: typeof e.qrLogoY === 'number' ? e.qrLogoY : null,
      customQrImageUrl: e.customQrImageUrl || null
    };
  });
  sendJSON(res, 200, { employees });
});

// --- الأدمن: عملاء موظف معين بالتحديد ---
route('GET', '/api/admin/employee-customers', async (req, res, query) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const data = db.get();
  const employee = data.employees.find(e => e.id === query.empId);
  if (!employee) return sendJSON(res, 404, { error: 'الموظف مش موجود' });
  const customers = data.customers
    .filter(c => c.ownerEmployeeId === employee.id)
    .map(publicCustomer)
    .sort((a, b) => b.points - a.points);
  sendJSON(res, 200, { employee: { name: employee.name, photoUrl: employee.photoUrl || null }, customers });
});

// --- الأدمن: إدارة كتالوج المكافآت بالكامل (إضافة / تعديل / حذف) ---
route('POST', '/api/admin/rewards/add', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { name, cost, employeeIds, imageUrl } = await readBody(req);
  const numCost = Math.round(Number(cost));
  if (!name || !name.trim() || !numCost || numCost <= 0) {
    return sendJSON(res, 400, { error: 'اسم الخدمة وعدد النقاط مطلوبين' });
  }
  const data = db.get();
  const reward = { id: 'rw_' + crypto.randomBytes(5).toString('hex'), employeeIds: Array.isArray(employeeIds) ? employeeIds : [], name: name.trim(), cost: numCost, imageUrl: imageUrl || null };
  data.rewards.push(reward);
  db.persist();
  sendJSON(res, 200, { reward });
});

route('POST', '/api/admin/rewards/update', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, name, cost, employeeIds, imageUrl } = await readBody(req);
  const data = db.get();
  const reward = data.rewards.find(r => r.id === id);
  if (!reward) return sendJSON(res, 404, { error: 'الخدمة دي مش موجودة' });
  if (name && name.trim()) reward.name = name.trim();
  const numCost = Math.round(Number(cost));
  if (numCost && numCost > 0) reward.cost = numCost;
  if (Array.isArray(employeeIds)) reward.employeeIds = employeeIds;
  if (typeof imageUrl === 'string') reward.imageUrl = imageUrl || null;
  db.persist();
  sendJSON(res, 200, { reward });
});

route('POST', '/api/admin/rewards/delete', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id } = await readBody(req);
  const data = db.get();
  const idx = data.rewards.findIndex(r => r.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'الخدمة دي مش موجودة' });
  data.rewards.splice(idx, 1);
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- الأدمن: إضافة موظف جديد برقم دخول يختاره ---
route('POST', '/api/admin/employees/add', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { name, branchId, code } = await readBody(req);
  if (!name || !name.trim() || !code || !branchId) {
    return sendJSON(res, 400, { error: 'الاسم والفرع والرقم مطلوبين' });
  }
  const data = db.get();
  const branch = data.branches.find(b => b.id === branchId);
  if (!branch) return sendJSON(res, 400, { error: 'الفرع ده مش موجود' });

  const codeTaken = data.employees.some(e => auth.verifyPin(code, e.pinHash)) || auth.verifyPin(code, (data.admins[0] || {}).codeHash || '');
  if (codeTaken) return sendJSON(res, 409, { error: 'الرقم ده مستخدم بالفعل، اختار رقم تاني' });

  const employee = { id: 'emp_' + crypto.randomBytes(5).toString('hex'), branchId, name: name.trim(), pinHash: db.hashPin(code) };
  data.employees.push(employee);
  db.persist();
  sendJSON(res, 200, { employee: { id: employee.id, name: employee.name, branchName: branch.name } });
});

// --- الأدمن: تغيير رقم دخول موظف ---
route('POST', '/api/admin/employees/reset-code', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, code } = await readBody(req);
  if (!code) return sendJSON(res, 400, { error: 'اكتب الرقم الجديد' });
  const data = db.get();
  const employee = data.employees.find(e => e.id === id);
  if (!employee) return sendJSON(res, 404, { error: 'الموظف مش موجود' });
  employee.pinHash = db.hashPin(code);
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- الأدمن: نقل موظف لفرع تاني ---
route('POST', '/api/admin/employees/move-branch', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, branchId } = await readBody(req);
  const data = db.get();
  const employee = data.employees.find(e => e.id === id);
  if (!employee) return sendJSON(res, 404, { error: 'الموظف مش موجود' });
  const branch = data.branches.find(b => b.id === branchId);
  if (!branch) return sendJSON(res, 404, { error: 'الفرع مش موجود' });
  employee.branchId = branchId;
  db.persist();
  sendJSON(res, 200, { ok: true, employee: { id: employee.id, branchId: employee.branchId } });
});

// --- الأدمن: حذف موظف (عملاءه بيفضلوا موجودين بس من غير موظف مسؤول عنهم) ---
route('POST', '/api/admin/employees/delete', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id } = await readBody(req);
  const data = db.get();
  const idx = data.employees.findIndex(e => e.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'الموظف مش موجود' });
  data.employees.splice(idx, 1);
  data.customers.forEach(c => { if (c.ownerEmployeeId === id) c.ownerEmployeeId = null; });
  data.rewards.forEach(r => { if (Array.isArray(r.employeeIds)) r.employeeIds = r.employeeIds.filter(eid => eid !== id); });
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- الأدمن: تعديل نقاط عميل يدويًا (تصحيح غلطة مثلاً) ---
route('POST', '/api/admin/customers/update', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, points, note, name, phone, plateNumber } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.id === id);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  const numPoints = Math.round(Number(points));
  if (Number.isFinite(numPoints)) {
    const diff = numPoints - customer.points;
    customer.points = numPoints;
    if (diff !== 0) {
      data.transactions.push({
        id: 'tx_' + crypto.randomBytes(6).toString('hex'),
        customerId: customer.id,
        type: diff > 0 ? 'earn' : 'redeem',
        amount: diff,
        desc: 'تعديل يدوي من الأدمن',
        createdAt: Date.now()
      });
    }
  }
  if (typeof note === 'string') customer.note = note.slice(0, 500);
  if (typeof name === 'string' && name.trim()) customer.name = name.trim();
  if (typeof phone === 'string' && phone.trim() && phone.trim() !== customer.phone) {
    const clash = data.customers.some(c => c.id !== customer.id && c.phone === phone.trim());
    if (clash) return sendJSON(res, 409, { error: 'الرقم ده مستخدم بحساب تاني بالفعل' });
    customer.phone = phone.trim();
  }
  if (typeof plateNumber === 'string' && plateNumber.trim()) customer.plateNumber = plateNumber.trim();
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer) });
});

// --- الأدمن: يشوف كل عمليات عميل معين بالتفصيل ---
route('GET', '/api/admin/customers/transactions', async (req, res, query) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const data = db.get();
  const items = data.transactions
    .filter(t => t.customerId === query.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  sendJSON(res, 200, { items });
});

// --- الأدمن: يغيّر كلمة سر عميل (لو اتقفل حسابه مثلًا) ---
route('POST', '/api/admin/customers/reset-password', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, newPassword } = await readBody(req);
  if (!newPassword || newPassword.length < 4) return sendJSON(res, 400, { error: 'كلمة السر لازم 4 حروف/أرقام على الأقل' });
  const data = db.get();
  const customer = data.customers.find(c => c.id === id);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  customer.passwordHash = auth.hashPassword(newPassword);
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- الأدمن: ينقل عميل لموظف تاني ---
route('POST', '/api/admin/customers/reassign', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, employeeId } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.id === id);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  if (employeeId) {
    const emp = data.employees.find(e => e.id === employeeId);
    if (!emp) return sendJSON(res, 400, { error: 'الموظف ده مش موجود' });
  }
  customer.ownerEmployeeId = employeeId || null;
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer) });
});

// --- الأدمن: يعدّل شكل وألوان QR أي موظف مباشرة ---
route('POST', '/api/admin/employees/qr-update', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, qrTemplate, qrColor, qrBgColor, qrLogoScale, qrLogoX, qrLogoY, customQrImageUrl } = await readBody(req);
  const data = db.get();
  const employee = data.employees.find(e => e.id === id);
  if (!employee) return sendJSON(res, 404, { error: 'الموظف مش موجود' });
  if (typeof qrTemplate === 'string' && qrTemplate) employee.qrTemplate = qrTemplate;
  if (typeof qrColor === 'string') employee.qrColor = qrColor || null;
  if (typeof qrBgColor === 'string') employee.qrBgColor = qrBgColor || null;
  if (typeof qrLogoScale === 'number' && qrLogoScale > 0) employee.qrLogoScale = qrLogoScale;
  if (typeof qrLogoX === 'number') employee.qrLogoX = qrLogoX;
  if (typeof qrLogoY === 'number') employee.qrLogoY = qrLogoY;
  if (typeof customQrImageUrl === 'string') employee.customQrImageUrl = customQrImageUrl || null;
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- الموظف يستبدل مكافأة لعميله شخصيًا (العميل واقف قدامه) ---
route('POST', '/api/employee/redeem', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const { phone, rewardId } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.phone === phone);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  if (customer.ownerEmployeeId && customer.ownerEmployeeId !== session.userId) {
    return sendJSON(res, 403, { error: 'العميل ده مش تابع لك' });
  }
  const reward = data.rewards.find(r => r.id === rewardId);
  if (!reward) return sendJSON(res, 404, { error: 'المكافأة دي مش موجودة' });
  if (reward.employeeIds && reward.employeeIds.length && !reward.employeeIds.includes(session.userId)) {
    return sendJSON(res, 403, { error: 'الخدمة دي مش متاحة عندك' });
  }
  if (customer.points < reward.cost) return sendJSON(res, 400, { error: 'رصيد العميل مش كافي للمكافأة دي' });
  customer.points -= reward.cost;
  data.transactions.push({
    id: 'tx_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id, type: 'redeem', amount: -reward.cost,
    desc: `استبدال: ${reward.name} (في الفرع)`, createdAt: Date.now()
  });
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer), message: `تم استبدال "${reward.name}" بنجاح` });
});

// --- الأدمن: يستبدل أي مكافأة لأي عميل، من غير قيود ملكية ---
route('POST', '/api/admin/customers/redeem', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { customerId, rewardId } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.id === customerId);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  const reward = data.rewards.find(r => r.id === rewardId);
  if (!reward) return sendJSON(res, 404, { error: 'المكافأة دي مش موجودة' });
  if (customer.points < reward.cost) return sendJSON(res, 400, { error: 'رصيد العميل مش كافي للمكافأة دي' });
  customer.points -= reward.cost;
  data.transactions.push({
    id: 'tx_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id, type: 'redeem', amount: -reward.cost,
    desc: `استبدال: ${reward.name} (بواسطة الأدمن)`, createdAt: Date.now()
  });
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer), message: `تم استبدال "${reward.name}" بنجاح` });
});


route('POST', '/api/admin/customers/delete', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id } = await readBody(req);
  const data = db.get();
  const idx = data.customers.findIndex(c => c.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  data.customers.splice(idx, 1);
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- الأدمن: كل الفروع ---
route('GET', '/api/admin/branches', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const data = db.get();
  sendJSON(res, 200, { branches: data.branches });
});

// --- الأدمن: إضافة فرع (محل) جديد — فروع بيانات بس، بدون تسجيل دخول خاص بيها ---
route('POST', '/api/admin/branches/add', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { name, address } = await readBody(req);
  if (!name || !name.trim()) return sendJSON(res, 400, { error: 'اسم الفرع مطلوب' });
  const data = db.get();
  const branch = { id: 'br_' + crypto.randomBytes(6).toString('hex'), name: name.trim(), address: (address || '').trim() };
  data.branches.push(branch);
  db.persist();
  sendJSON(res, 200, { branch });
});

// --- الأدمن: تعديل بيانات فرع (الاسم والعنوان) ---
route('POST', '/api/admin/branches/update', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id, name, address } = await readBody(req);
  const data = db.get();
  const branch = data.branches.find(b => b.id === id);
  if (!branch) return sendJSON(res, 404, { error: 'الفرع مش موجود' });
  if (name && name.trim()) branch.name = name.trim();
  if (typeof address === 'string') branch.address = address.trim();
  db.persist();
  sendJSON(res, 200, { branch });
});

// --- الأدمن: حذف فرع (لازم ميكونش فيه موظفين شغالين عليه الأول) ---
route('POST', '/api/admin/branches/delete', async (req, res) => {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كأدمن' });
  const { id } = await readBody(req);
  const data = db.get();
  const idx = data.branches.findIndex(b => b.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: 'الفرع مش موجود' });
  const hasEmployees = data.employees.some(e => e.branchId === id);
  if (hasEmployees) return sendJSON(res, 400, { error: 'مينفعش تحذف الفرع ده وفيه موظفين شغالين عليه، انقلهم لفرع تاني الأول' });
  data.branches.splice(idx, 1);
  db.persist();
  sendJSON(res, 200, { ok: true });
});

// --- بيانات الموظف نفسه (اسمه، صورته، فرعه) ---
route('GET', '/api/employee/me', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const data = db.get();
  const employee = data.employees.find(e => e.id === session.userId);
  if (!employee) return sendJSON(res, 404, { error: 'الحساب مش موجود' });
  const branch = data.branches.find(b => b.id === employee.branchId);
  sendJSON(res, 200, {
    employee: {
      id: employee.id, name: employee.name, phone: employee.phone || null, address: employee.address || null,
      photoUrl: employee.photoUrl || null,
      qrColor: employee.qrColor || null, qrBgColor: employee.qrBgColor || null, qrLogoUrl: employee.qrLogoUrl || null,
      qrTemplate: employee.qrTemplate || null,
      qrLogoScale: employee.qrLogoScale || null, qrLogoX: typeof employee.qrLogoX === 'number' ? employee.qrLogoX : null,
      qrLogoY: typeof employee.qrLogoY === 'number' ? employee.qrLogoY : null,
      customQrImageUrl: employee.customQrImageUrl || null
    },
    branch: branch ? { name: branch.name } : null
  });
});

// --- الموظف بيعدّل اسمه وصورته وتخصيص الـ QR بتاعه ---
route('POST', '/api/employee/profile', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const { name, phone, address, photoUrl, qrColor, qrBgColor, qrLogoUrl, qrTemplate, qrLogoScale, qrLogoX, qrLogoY } = await readBody(req);
  const data = db.get();
  const employee = data.employees.find(e => e.id === session.userId);
  if (!employee) return sendJSON(res, 404, { error: 'الحساب مش موجود' });
  if (name && name.trim()) employee.name = name.trim();
  if (typeof phone === 'string') employee.phone = phone.trim() || null;
  if (typeof address === 'string') employee.address = address.trim() || null;
  if (typeof photoUrl === 'string') employee.photoUrl = photoUrl || null;
  if (typeof qrColor === 'string') employee.qrColor = qrColor || null;
  if (typeof qrBgColor === 'string') employee.qrBgColor = qrBgColor || null;
  if (typeof qrLogoUrl === 'string') employee.qrLogoUrl = qrLogoUrl || null;
  if (typeof qrTemplate === 'string' && qrTemplate) employee.qrTemplate = qrTemplate;
  if (typeof qrLogoScale === 'number' && qrLogoScale > 0) employee.qrLogoScale = qrLogoScale;
  if (typeof qrLogoX === 'number') employee.qrLogoX = qrLogoX;
  if (typeof qrLogoY === 'number') employee.qrLogoY = qrLogoY;
  db.persist();
  sendJSON(res, 200, {
    employee: {
      id: employee.id, name: employee.name, phone: employee.phone || null, address: employee.address || null,
      photoUrl: employee.photoUrl || null,
      qrColor: employee.qrColor || null, qrBgColor: employee.qrBgColor || null, qrLogoUrl: employee.qrLogoUrl || null,
      qrTemplate: employee.qrTemplate || null,
      qrLogoScale: employee.qrLogoScale || null, qrLogoX: typeof employee.qrLogoX === 'number' ? employee.qrLogoX : null,
      qrLogoY: typeof employee.qrLogoY === 'number' ? employee.qrLogoY : null
    }
  });
});

// --- عملاء الموظف هو بس (مش عملاء الموظفين التانيين) ---
route('GET', '/api/employee/customers', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const data = db.get();
  const customers = data.customers
    .filter(c => c.ownerEmployeeId === session.userId)
    .map(publicCustomer)
    .sort((a, b) => b.points - a.points);
  sendJSON(res, 200, { customers });
});

// --- الموظف يكتب ملاحظة/داتا عن عميله (بيشوفها هو والأدمن بس) ---
route('POST', '/api/employee/customers/note', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const { phone, note } = await readBody(req);
  const data = db.get();
  const customer = data.customers.find(c => c.phone === phone);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  if (customer.ownerEmployeeId && customer.ownerEmployeeId !== session.userId) {
    return sendJSON(res, 403, { error: 'العميل ده مش تابع لك' });
  }
  customer.note = (note || '').slice(0, 500);
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer) });
});


// --- الموظف يشوف حركات (كسب/استبدال) عميل تابع له بس ---
route('GET', '/api/employee/customers/transactions', async (req, res, query) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const data = db.get();
  const customer = data.customers.find(c => c.phone === query.phone);
  if (!customer) return sendJSON(res, 404, { error: 'العميل مش موجود' });
  if (customer.ownerEmployeeId && customer.ownerEmployeeId !== session.userId) {
    return sendJSON(res, 403, { error: 'العميل ده مش تابع لك' });
  }
  const items = data.transactions
    .filter(t => t.customerId === customer.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);
  sendJSON(res, 200, { items });
});

route('GET', '/api/employee/lookup', async (req, res, query) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const data = db.get();
  const customer = data.customers.find(c => c.phone === query.phone);
  if (!customer) return sendJSON(res, 200, { found: false });
  const belongsToOther = !!(customer.ownerEmployeeId && customer.ownerEmployeeId !== session.userId);
  const owner = belongsToOther ? data.employees.find(e => e.id === customer.ownerEmployeeId) : null;
  sendJSON(res, 200, {
    found: true,
    customer: publicCustomer(customer),
    belongsToOther,
    ownerName: owner ? owner.name : null
  });
});

// --- تسجيل غسلة وإضافة نقاط: كل عميل تابع لموظف واحد بس ---
route('POST', '/api/employee/wash', async (req, res) => {
  const session = requireEmployee(req);
  if (!session) return sendJSON(res, 401, { error: 'محتاج تسجل دخول كموظف' });
  const { phone, name, amountSpent, description } = await readBody(req);
  const amount = Math.round(Number(amountSpent));
  if (!phone || !amount || amount <= 0) {
    return sendJSON(res, 400, { error: 'رقم الهاتف ومبلغ الفاتورة مطلوبين' });
  }
  const data = db.get();
  const branch = data.branches.find(b => b.id === session.branchId);
  let customer = data.customers.find(c => c.phone === phone);

  if (!customer) {
    // عميل جديد أول مرة — بيتسجل بدون باسورد، وبيبقى تابع للموظف ده تلقائي
    customer = {
      id: 'cus_' + crypto.randomBytes(6).toString('hex'),
      name: name || 'عميل جديد',
      phone,
      passwordHash: null,
      points: 0,
      lastBonusDate: null,
      ownerEmployeeId: session.userId,
      createdAt: Date.now()
    };
    data.customers.push(customer);
  } else if (customer.ownerEmployeeId && customer.ownerEmployeeId !== session.userId) {
    // العميل ده أصلاً تابع لموظف تاني — مينفعش ياخد نقط من هنا برضو
    const owner = data.employees.find(e => e.id === customer.ownerEmployeeId);
    return sendJSON(res, 403, {
      error: `العميل ده تابع لـ ${owner ? owner.name : 'موظف تاني'}، مينفعش يتسجل ليه نقط من غير حسابه`
    });
  } else if (!customer.ownerEmployeeId) {
    // أول غسلة له، فبيبقى تابع للموظف اللي سجلها
    customer.ownerEmployeeId = session.userId;
  }

  customer.points += amount; // معادلة بسيطة: 1 جنيه = 1 نقطة
  data.transactions.push({
    id: 'tx_' + crypto.randomBytes(6).toString('hex'),
    customerId: customer.id,
    type: 'earn',
    amount,
    desc: description || 'غسلة',
    branchName: branch ? branch.name : '',
    createdAt: Date.now()
  });
  db.persist();
  sendJSON(res, 200, { customer: publicCustomer(customer), added: amount });
});

// ---------- السيرفر ----------

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams);

  if (pathname.startsWith('/api/')) {
    const found = routes.find(r => r.method === req.method && r.pattern === pathname);
    if (!found) return sendJSON(res, 404, { error: 'المسار مش موجود' });
    try {
      await found.handler(req, res, query);
    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: 'حصل خطأ في السيرفر، حاول تاني' });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`لمعة شغال على http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('تعذر تشغيل قاعدة البيانات:', err.message);
  process.exit(1);
});
