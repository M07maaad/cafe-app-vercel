const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase Client Initialization ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
}

// --- NEW DIAGNOSTIC ENDPOINT ---
// This endpoint will help us verify if the environment variables are being read correctly.
app.get('/test-env', (req, res) => {
    try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_KEY;

        res.status(200).json({
            message: "مرحباً! هذا اختبار للتأكد من قراءة المتغيرات.",
            SUPABASE_URL_IS_SET: !!url,
            SUPABASE_KEY_IS_SET: !!key,
            tip: "لو وجدت قيمة أي من المتغيرات false، فهذا يعني أن Vercel لم يقرأها. تأكد من صحة الأسماء والمشروع."
        });
    } catch (e) {
        res.status(500).json({ error: "حدث خطأ في نقطة الاختبار.", details: e.message });
    }
});


// --- The rest of your API routes ---

app.post('/login', async (req, res) => {
    if (!supabase) {
        return res.status(500).json({ 
            error: "خطأ في السيرفر: Supabase غير مهيأ. تأكد من متغيرات البيئة في Vercel.",
            SUPABASE_URL_IS_SET: !!process.env.SUPABASE_URL,
            SUPABASE_KEY_IS_SET: !!process.env.SUPABASE_KEY,
        });
    }
    // ... rest of the login logic
    try {
        const { studentId, password } = req.body;
        const email = `${studentId}@chilli-app.io`;
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            return res.status(400).json({ error: "الرقم الجامعي أو كلمة المرور غير صحيحة." });
        }
        res.status(200).json(data);
    } catch (e) {
        res.status(500).json({ error: "حدث خطأ فادح أثناء تسجيل الدخول." });
    }
});


// All other routes like /signup, /menu, etc. remain the same
app.post('/signup', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not configured." });
    try {
        const { name, studentId, password } = req.body;
        const email = `${studentId}@chilli-app.io`;
        const { data: { user, session }, error: authError } = await supabase.auth.signUp({ email, password });
        if (authError) {
            if (authError.message.includes("User already registered")) {
                return res.status(400).json({ error: "هذا الرقم الجامعي مسجل بالفعل." });
            }
            throw authError;
        }
        await supabase.from('users').insert({ id: user.id, name, studentId });
        await supabase.from('wallets').insert({ user_id: user.id, balance: 0 });
        res.status(200).json({ session, user });
    } catch (error) {
        res.status(500).json({ error: "An unexpected error occurred during signup." });
    }
});

app.get('/menu', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Server not configured." });
    try {
        const { data, error } = await supabase.from('menu').select('*');
        if (error) throw error;
        const menuByCategory = data.reduce((acc, item) => {
            if (!acc[item.category]) acc[item.category] = [];
            acc[item.category].push(item);
            return acc;
        }, {});
        res.status(200).json(menuByCategory);
    } catch (error) {
        res.status(500).json({ error: "Could not fetch menu." });
    }
});

const authCheck = async (req, res, next) => {
    if (!supabase) return res.status(500).json({ error: "Server Error: Supabase client is not initialized." });
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided.' });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token.' });
    req.user = user;
    next();
};

app.get('/user-details', authCheck, (req, res) => { /* ... existing code ... */ });
app.get('/orders', authCheck, (req, res) => { /* ... existing code ... */ });
app.post('/process-wallet-order', authCheck, (req, res) => { /* ... existing code ... */ });
app.post('/start-paymob-payment', authCheck, (req, res) => { /* ... existing code ... */ });
app.post('/confirm-paymob-callback', (req, res) => { /* ... existing code ... */ });

module.exports = app;
```

#### الخطوة 2: اختبار المشكلة

1.  احفظ التغيير على GitHub وانتظر الـ deployment الجديد على Vercel يخلص.
2.  المرة دي مش هتجرب تسجل دخول. هتعمل حاجة تانية:
3.  افتح رابط التطبيق بتاعك، وفي آخر العنوان، ضيف `/api/test-env`.
    يعني لو رابطك `chilli-app.vercel.app`، هتفتح الرابط ده:
    **`https://chilli-app.vercel.app/api/test-env`**

**إيه اللي المفروض تشوفه؟**
المفروض تشوف صفحة بيضاء فيها رسالة JSON زي دي:
```json
{
  "message": "مرحباً! هذا اختبار للتأكد من قراءة المتغيرات.",
  "SUPABASE_URL_IS_SET": true,
  "SUPABASE_KEY_IS_SET": true,
  "tip": "..."
}

