const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const router = express.Router();
router.use(express.json());

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- USER AUTH MIDDLEWARE ---
const userAuthCheck = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided.' });
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token.' });
    
    req.user = user;
    next();
};

// --- DASHBOARD AUTH MIDDLEWARE ---
const dashboardAuthCheck = (req, res, next) => {
    const password = req.headers.authorization?.split(' ')[1];
    if (!password || password !== process.env.DASHBOARD_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized: Invalid dashboard password.' });
    }
    next();
};

// --- USER-FACING ROUTES ---
router.post('/signup', async (req, res) => {
    try {
        const { name, studentId, password } = req.body;
        const email = `user-${studentId}@chilli-app.io`;
        const { data: { user, session }, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        await supabase.from('users').insert({ id: user.id, name, studentId });
        await supabase.from('wallets').insert({ user_id: user.id, balance: 0 });
        res.status(200).json({ session, user });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { studentId, password } = req.body;
        const email = `user-${studentId}@chilli-app.io`;
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(400).json({ error: "الرقم الجامعي أو كلمة المرور غير صحيحة." });
    }
});

router.get('/menu', async (req, res) => {
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

router.get('/user-details', userAuthCheck, async (req, res) => {
    try {
        const { data: u, error: uErr } = await supabase.from('users').select('name, studentId').eq('id', req.user.id).single();
        const { data: w, error: wErr } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
        if (uErr || wErr) throw new Error("Could not fetch user data.");
        res.status(200).json({ ...u, ...w });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/orders', userAuthCheck, async (req, res) => {
    try {
        const { data, error } = await supabase.from('orders').select('*').eq('user_id', req.user.id).neq('paymentMethod', 'Card_Pending').order('created_at', { ascending: false });
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: "Could not fetch orders." });
    }
});

// User tracks order using the new display_id (e.g., chilli-0001)
router.get('/order-status/:id', userAuthCheck, async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('orders').select('status').eq('display_id', id).single();
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(404).json({ error: "Order not found." });
    }
});

router.post('/process-wallet-order', userAuthCheck, async (req, res) => {
    const { items, notes } = req.body;
    const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    try {
        const { data: wallet, error: fetchError } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
        if (fetchError || !wallet || wallet.balance < totalPrice) return res.status(400).json({ error: "رصيدك غير كافٍ." });

        // Generate the new custom order ID by calling the database function
        const { data: displayId, error: rpcError } = await supabase.rpc('get_next_order_display_id');
        if (rpcError) throw new Error("Could not generate order ID.");

        await supabase.from('wallets').update({ balance: wallet.balance - totalPrice }).eq('user_id', req.user.id);
        
        // Insert the new order with the custom display_id
        await supabase.from('orders').insert({ 
            display_id: displayId,
            user_id: req.user.id, 
            items, 
            totalPrice, 
            paymentMethod: 'Wallet', 
            notes, 
            status: 'قيد التحضير' 
        });

        // Return the new display_id to the user
        res.status(200).json({ status: "success", orderId: displayId });
    } catch (error) {
        console.error("Wallet Order Error:", error.message);
        res.status(500).json({ error: "Failed to create wallet order." });
    }
});

router.post('/start-paymob-payment', userAuthCheck, async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || items.length === 0) return res.status(400).json({ error: "Cart is empty." });
        
        const { data: user } = await supabase.from('users').select('name, studentId').eq('id', req.user.id).single();
        const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
        const amountCents = Math.round(totalPrice * 100);

        // Generate our custom order ID first
        const { data: displayId, error: rpcError } = await supabase.rpc('get_next_order_display_id');
        if (rpcError) throw new Error("Could not generate order ID.");

        // Paymob Flow - Step 1: Authentication
        const authResponse = await axios.post("https://accept.paymob.com/api/auth/tokens", { api_key: process.env.PAYMOB_API_KEY });
        const authToken = authResponse.data.token;

        // Paymob Flow - Step 2: Order Registration
        // Use our custom displayId as the merchant_order_id
        const orderPayload = { 
            auth_token: authToken, 
            delivery_needed: "false", 
            amount_cents: amountCents, 
            currency: "EGP", 
            merchant_order_id: displayId, // Use our custom ID here
            items: items.map(i => ({ name: i.name, amount_cents: Math.round(i.price * 100), quantity: i.quantity })) 
        };
        const orderResponse = await axios.post("https://accept.paymob.com/api/ecommerce/orders", orderPayload);
        const paymobOrderId = orderResponse.data.id;
        
        // Insert a temporary order in our DB before payment
        await supabase.from('orders').insert({ 
            display_id: displayId,
            id: paymobOrderId, // Also store paymob's ID if needed for reconciliation
            user_id: req.user.id, 
            items, 
            totalPrice, 
            paymentMethod: 'Card_Pending', 
            status: 'الدفع معلق' 
        });

        // Paymob Flow - Step 3: Payment Key Request
        const paymentKeyPayload = { auth_token: authToken, amount_cents: amountCents, expiration: 3600, order_id: paymobOrderId, currency: "EGP", integration_id: parseInt(process.env.PAYMOB_INTEGRATION_ID), billing_data: { first_name: user.name.split(' ')[0] || "NA", last_name: user.name.split(' ').slice(1).join(' ') || "NA", email: `user-${user.studentId}@chilli-app.io`, phone_number: "+201208087322", apartment: "NA", floor: "NA", street: "NA", building: "NA", shipping_method: "NA", postal_code: "NA", city: "NA", country: "EG", state: "NA" }};
        const paymentKeyResponse = await axios.post("https://accept.paymob.com/api/acceptance/payment_keys", paymentKeyPayload);
        
        const redirectUrl = `https://accept.paymob.com/api/acceptance/iframes/${process.env.PAYMOB_IFRAME_ID}?payment_token=${paymentKeyResponse.data.token}`;
        res.status(200).json({ redirectUrl });

    } catch (error) {
        console.error("Paymob Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to connect to payment gateway." });
    }
});

// Paymob webhook now finds the order using the merchant_order_id (our display_id)
router.post('/confirm-paymob-callback', async (req, res) => {
    try {
        const { obj } = req.body;
        if (obj && obj.success === true) {
            const displayId = obj.order.merchant_order_id;
            await supabase.from('orders').update({ paymentMethod: 'Card', status: 'قيد التحضير' }).eq('display_id', displayId);
        }
    } catch (error) {
        console.error(`Failed to process Paymob callback:`, error);
    }
    res.status(200).send();
});


// --- DASHBOARD-ONLY ROUTES ---
router.get('/all-orders', dashboardAuthCheck, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select(`
                id, display_id, created_at, items, totalPrice, paymentMethod, notes, status,
                users ( name, studentId )
            `)
            .eq('status', 'قيد التحضير')
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Could not fetch active orders.' });
    }
});

// Dashboard actions now use the string display_id
router.post('/update-order-status', dashboardAuthCheck, async (req, res) => {
    try {
        const { orderId, status } = req.body; // orderId is now display_id
        if (!orderId || !status) return res.status(400).json({ error: 'Missing orderId or status.' });

        const { error } = await supabase
            .from('orders')
            .update({ status: status })
            .eq('display_id', orderId);
        
        if (error) throw error;
        res.status(200).json({ success: true, message: `Order ${orderId} updated to ${status}` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update order status.' });
    }
});

router.post('/reject-order', dashboardAuthCheck, async (req, res) => {
    const { orderId, reason } = req.body; // orderId is now display_id
    if (!orderId || !reason) {
        return res.status(400).json({ error: 'Missing orderId or reason.' });
    }

    try {
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .select('user_id, totalPrice, paymentMethod')
            .eq('display_id', orderId)
            .single();

        if (orderError || !order) throw new Error('Order not found.');

        if (order.paymentMethod === 'Wallet') {
            const { data: wallet, error: walletError } = await supabase
                .from('wallets')
                .select('balance')
                .eq('user_id', order.user_id)
                .single();
            if (walletError || !wallet) throw new Error('User wallet not found for refund.');
            
            const newBalance = parseFloat(wallet.balance) + parseFloat(order.totalPrice);
            
            const { error: updateWalletError } = await supabase
                .from('wallets')
                .update({ balance: newBalance })
                .eq('user_id', order.user_id);
            if (updateWalletError) throw new Error('Failed to refund to wallet.');
        }

        await supabase
            .from('orders')
            .update({ status: 'مرفوض', notes: `سبب الرفض: ${reason}` })
            .eq('display_id', orderId);

        res.status(200).json({ success: true, message: `Order ${orderId} has been rejected.` });
    } catch (error) {
        console.error("Reject Order Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

