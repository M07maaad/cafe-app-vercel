const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// --- The Standard and Correct Way to Initialize ---
// Initialize the Supabase client once at the top level.
// This is the most stable and recommended pattern.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Middleware to check JWT token
const authCheck = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided.' });
    }
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        return res.status(401).json({ error: 'Invalid token.' });
    }
    req.user = user;
    next();
};

// --- API ROUTES ---

app.post('/signup', async (req, res) => {
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
        console.error("Signup Error:", error.message);
        res.status(500).json({ error: "An unexpected error occurred during signup." });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { studentId, password } = req.body;
        const email = `${studentId}@chilli-app.io`;
        
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            return res.status(400).json({ error: "الرقم الجامعي أو كلمة المرور غير صحيحة." });
        }
        
        res.status(200).json(data);
    } catch (error) {
        console.error("Login Error:", error.message);
        res.status(500).json({ error: "An unexpected error occurred during login." });
    }
});

app.get('/menu', async (req, res) => {
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
        console.error("Menu Fetch Error:", error.message);
        res.status(500).json({ error: "Could not fetch menu." });
    }
});

// Protected routes
app.get('/user-details', authCheck, async (req, res) => {
    try {
        const { data: userData, error: userError } = await supabase.from('users').select('name, studentId').eq('id', req.user.id).single();
        const { data: walletData, error: walletError } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
        
        if (userError || walletError) throw new Error("Could not fetch user data.");
        
        res.status(200).json({ ...userData, ...walletData });
    } catch (error) {
        console.error("User Details Error:", error.message);
        res.status(500).json({ error: "Could not fetch user details." });
    }
});

app.get('/orders', authCheck, async (req, res) => {
    try {
        const { data, error } = await supabase.from('orders').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        console.error("Fetch Orders Error:", error.message);
        res.status(500).json({ error: "Could not fetch orders." });
    }
});

app.post('/process-wallet-order', authCheck, async (req, res) => {
    const { items, notes } = req.body;
    const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    try {
        const { data: wallet, error: fetchError } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
        if (fetchError || !wallet || wallet.balance < totalPrice) {
            return res.status(400).json({ error: "رصيدك غير كافٍ." });
        }
        
        const newBalance = wallet.balance - totalPrice;
        await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', req.user.id);
        
        const { data: orderData, error: orderError } = await supabase.from('orders').insert({ user_id: req.user.id, items, totalPrice, paymentMethod: 'Wallet', notes, status: 'قيد التحضير' }).select('id').single();
        if (orderError) throw orderError;
        
        res.status(200).json({ status: "success", orderId: orderData.id });
    } catch (error) {
        console.error("Wallet Order Error:", error.message);
        res.status(500).json({ error: "Failed to create order." });
    }
});

app.post('/start-paymob-payment', authCheck, async (req, res) => {
    try {
        const { items } = req.body;
        const { data: user } = await supabase.from('users').select('name, studentId').eq('id', req.user.id).single();
        const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const amountCents = Math.round(totalPrice * 100);
        const merchantOrderId = `chilli-${Date.now()}`;

        const authResponse = await axios.post("https://accept.paymob.com/api/auth/tokens", { api_key: process.env.PAYMOB_API_KEY });
        const authToken = authResponse.data.token;

        const orderPayload = { auth_token: authToken, delivery_needed: "false", merchant_order_id: merchantOrderId, amount_cents: amountCents, currency: "EGP", items: items.map(i => ({ name: i.name, amount_cents: Math.round(i.price * 100), quantity: i.quantity })) };
        const orderResponse = await axios.post("https://accept.paymob.com/api/ecommerce/orders", orderPayload);
        const paymobOrderId = orderResponse.data.id;

        await supabase.from('orders').insert({ id: paymobOrderId, user_id: req.user.id, items, totalPrice, paymentMethod: 'Card_Pending', status: 'الدفع معلق' });

        const paymentKeyPayload = { auth_token: authToken, amount_cents: amountCents, expiration: 3600, order_id: paymobOrderId, currency: "EGP", integration_id: parseInt(process.env.PAYMOB_INTEGRATION_ID), billing_data: { first_name: user.name.split(' ')[0], last_name: user.name.split(' ').slice(1).join(' ') || user.name.split(' ')[0], email: `${user.studentId}@chilli-app.io`, phone_number: "+201208087322", apartment: "NA", floor: "NA", street: "NA", building: "NA", shipping_method: "NA", postal_code: "NA", city: "NA", country: "EG", state: "NA" }};
        const paymentKeyResponse = await axios.post("https://accept.paymob.com/api/acceptance/payment_keys", paymentKeyPayload);
        
        const redirectUrl = `https://accept.paymob.com/api/acceptance/iframes/${process.env.PAYMOB_IFRAME_ID}?payment_token=${paymentKeyResponse.data.token}`;
        res.status(200).json({ redirectUrl });
    } catch (error) {
        console.error("Paymob Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to connect to payment gateway." });
    }
});

app.post('/confirm-paymob-callback', async (req, res) => {
    try {
        const { obj } = req.body;
        if (obj && obj.success === true) {
            const paymobOrderId = obj.order.id;
            await supabase.from('orders').update({ paymentMethod: 'Card', status: 'قيد التحضير' }).eq('id', paymobOrderId);
            console.log(`Order ${paymobOrderId} confirmed successfully.`);
        }
    } catch (error) {
        console.error(`Failed to process Paymob callback:`, error);
    }
    res.status(200).send();
});

// Export the app for Vercel
module.exports = app;

