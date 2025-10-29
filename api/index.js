const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const webpush = require('web-push');

const router = express.Router();
router.use(express.json());

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Configure Web Push Safely ---
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    'mailto:your-email@example.com', // **هام: استبدل هذا بإيميلك**
    vapidPublicKey,
    vapidPrivateKey
  );
  console.log('VAPID keys loaded. Push notifications enabled.');
} else {
  console.warn('VAPID keys are NOT set. Push notifications will be disabled.');
}
// --- End of Web Push Config ---

// --- AUTH MIDDLEWARE ---
const userAuthCheck = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided.' });
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token.' });
    
    req.user = user;
    next();
};

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

        const { data: displayId, error: rpcError } = await supabase.rpc('get_next_order_display_id');
        if (rpcError) throw new Error("Could not generate order ID.");

        await supabase.from('wallets').update({ balance: wallet.balance - totalPrice }).eq('user_id', req.user.id);
        
        await supabase.from('orders').insert({ 
            display_id: displayId,
            user_id: req.user.id, 
            items, 
            totalPrice, 
            paymentMethod: 'Wallet', 
            notes, 
            status: 'قيد التحضير' 
        });

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

        const { data: displayId, error: rpcError } = await supabase.rpc('get_next_order_display_id');
        if (rpcError) throw new Error("Could not generate order ID.");

        const authResponse = await axios.post("https://accept.paymob.com/api/auth/tokens", { api_key: process.env.PAYMOB_API_KEY });
        const authToken = authResponse.data.token;

        const orderPayload = { 
            auth_token: authToken, 
            delivery_needed: "false", 
            amount_cents: amountCents, 
            currency: "EGP", 
            merchant_order_id: displayId,
            items: items.map(i => ({ name: i.name, amount_cents: Math.round(i.price * 100), quantity: i.quantity })) 
        };
        const orderResponse = await axios.post("https://accept.paymob.com/api/ecommerce/orders", orderPayload);
        const paymobOrderId = orderResponse.data.id;
        
        await supabase.from('orders').insert({ 
            display_id: displayId,
            id: paymobOrderId, 
            user_id: req.user.id, 
            items, 
            totalPrice, 
            paymentMethod: 'Card_Pending', 
            status: 'الدفع معلق' 
        });

        const paymentKeyPayload = { auth_token: authToken, amount_cents: amountCents, expiration: 3600, order_id: paymobOrderId, currency: "EGP", integration_id: parseInt(process.env.PAYMOB_INTEGRATION_ID), billing_data: { first_name: user.name.split(' ')[0] || "NA", last_name: user.name.split(' ').slice(1).join(' ') || "NA", email: `user-${user.studentId}@chilli-app.io`, phone_number: "+201208087322", apartment: "NA", floor: "NA", street: "NA", building: "NA", shipping_method: "NA", postal_code: "NA", city: "NA", country: "EG", state: "NA" }};
        const paymentKeyResponse = await axios.post("https://accept.paymob.com/api/acceptance/payment_keys", paymentKeyPayload);
        
        const redirectUrl = `https://accept.paymob.com/api/acceptance/iframes/${process.env.PAYMOB_IFRAME_ID}?payment_token=${paymentKeyResponse.data.token}`;
        res.status(200).json({ redirectUrl });

    } catch (error) {
        console.error("Paymob Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to connect to payment gateway." });
    }
});

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

// --- PUSH NOTIFICATION ROUTES ---

router.get('/vapid-public-key', (req, res) => {
  if (!vapidPublicKey) {
    return res.status(500).json({ error: 'VAPID public key not configured.' });
  }
  res.status(200).json({ publicKey: vapidPublicKey });
});

router.post('/subscribe', userAuthCheck, async (req, res) => {
  const subscription = req.body.subscription;
  const userId = req.user.id;
  if (!subscription) {
    return res.status(400).json({ error: 'No subscription object provided.' });
  }
  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .insert({ user_id: userId, subscription: subscription });
    if (error) throw error;
    res.status(201).json({ success: true, message: 'Subscribed successfully.' });
  } catch (error) {
    console.error('Subscription error:', error.message);
    res.status(500).json({ error: 'Failed to save subscription.' });
  }
});

router.post('/unsubscribe', userAuthCheck, async (req, res) => {
    const endpoint = req.body.endpoint;
    if (!endpoint) {
        return res.status(400).json({ error: 'No endpoint provided.' });
    }
    try {
        const { error } = await supabase
            .from('push_subscriptions')
            .delete()
            .eq('subscription->>endpoint', endpoint);
            
        if (error) throw error;
        res.status(200).json({ success: true, message: 'Unsubscribed successfully.' });
    } catch (error) {
        console.error('Unsubscription error:', error.message);
        res.status(500).json({ error: 'Failed to remove subscription.' });
    }
});


// --- DASHBOARD-ONLY ROUTES ---

router.get('/all-orders', dashboardAuthCheck, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('orders')
            .select(`id, display_id, created_at, items, totalPrice, paymentMethod, notes, status, user_id, users ( name, studentId )`)
            .eq('status', 'قيد التحضير')
            .order('created_at', { ascending: true });
        if (error) throw error;
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Could not fetch active orders.' });
    }
});

router.post('/update-order-status', dashboardAuthCheck, async (req, res) => {
    try {
        const { orderId, status } = req.body;
        if (!orderId || !status) return res.status(400).json({ error: 'Missing orderId or status.' });
        
        const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .select('user_id')
            .eq('display_id', orderId)
            .single();

        if (orderError || !orderData) throw new Error('Order not found.');
        
        const { error } = await supabase.from('orders').update({ status }).eq('display_id', orderId);
        if (error) throw error;

        if (status === 'جاهز للاستلام' && vapidPublicKey) {
            sendNotification(orderData.user_id, {
                title: 'طلبك جاهز! 🎉',
                body: `طلبك رقم ${orderId} جاهز للاستلام.`,
                icon: 'https://placehold.co/192x192/FDCB01/121212?text=BV'
            });
        }
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Update Status Error:', error.message);
        res.status(500).json({ error: 'Failed to update order status.' });
    }
});

router.post('/reject-order', dashboardAuthCheck, async (req, res) => {
    const { orderId, reason } = req.body;
    if (!orderId || !reason) return res.status(400).json({ error: 'Missing orderId or reason.' });
    try {
        const { data: order, error: orderError } = await supabase.from('orders').select('user_id, totalPrice, paymentMethod').eq('display_id', orderId).single();
        if (orderError) throw new Error('Order not found.');
        if (order.paymentMethod === 'Wallet') {
            const { data: wallet, error: walletError } = await supabase.from('wallets').select('balance').eq('user_id', order.user_id).single();
            if (walletError) throw new Error('User wallet not found for refund.');
            const newBalance = parseFloat(wallet.balance) + parseFloat(order.totalPrice);
            const { error: updateWalletError } = await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', order.user_id);
            if (updateWalletError) throw new Error('Failed to refund to wallet.');
        }
        await supabase.from('orders').update({ status: 'مرفوض', notes: `سبب الرفض: ${reason}` }).eq('display_id', orderId);
        
        if (vapidPublicKey) {
             sendNotification(order.user_id, {
                title: 'تم رفض طلبك 😕',
                body: `تم رفض طلبك رقم ${orderId}. السبب: ${reason}`,
                icon: 'https://placehold.co/192x192/FDCB01/121212?text=BV'
            });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/find-user', dashboardAuthCheck, async (req, res) => {
    const { studentId } = req.body;
    if (!studentId) return res.status(400).json({ error: 'Student ID is required.' });
    try {
        const { data: user, error: userError } = await supabase.from('users').select('id, name').eq('studentId', studentId).single();
        if (userError || !user) throw new Error('User not found.');
        
        const { data: wallet, error: walletError } = await supabase.from('wallets').select('balance').eq('user_id', user.id).single();
        if (walletError || !wallet) throw new Error('Wallet not found for this user.');

        res.status(200).json({ success: true, user: { id: user.id, name: user.name, studentId, balance: wallet.balance } });
    } catch (error) {
        res.status(404).json({ error: 'الطالب غير موجود.' });
    }
});

router.post('/charge-wallet', dashboardAuthCheck, async (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ error: 'User ID and a valid positive amount are required.' });
    }
    try {
        const { data: wallet, error: walletError } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
        if (walletError || !wallet) throw new Error('Wallet not found.');
        
        const newBalance = parseFloat(wallet.balance) + parseFloat(amount);
        
        const { error: updateError } = await supabase.from('wallets').update({ balance: newBalance }).eq('user_id', userId);
        if (updateError) throw updateError;
        
        res.status(200).json({ success: true, newBalance });
    } catch(error) {
        res.status(500).json({ error: 'فشل شحن الرصيد.' });
    }
});

router.get('/analytics', dashboardAuthCheck, async (req, res) => {
    const { period = 'day' } = req.query;
    try {
        let startDate = new Date();
        if (period === 'day') startDate.setHours(0, 0, 0, 0);
        else if (period === 'week') startDate.setDate(startDate.getDate() - 7);
        else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);

        const { data: orders, error } = await supabase
            .from('orders')
            .select('items, totalPrice, created_at, user_id, users(name, studentId)')
            .gte('created_at', startDate.toISOString())
            .in('status', ['جاهز للاستلام', 'قيد التحضير']);

        if (error) throw error;

        const itemCounts = {};
        orders.forEach(order => order.items.forEach(item => {
            itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
        }));
        const topItems = Object.entries(itemCounts).sort(([, a], [, b]) => b - a).slice(0, 5).map(([name, count]) => ({ name, count }));

        const customerSpending = {};
        orders.forEach(order => {
            const customerName = order.users?.name || `User ${order.user_id}`;
            customerSpending[customerName] = (customerSpending[customerName] || 0) + parseFloat(order.totalPrice);
        });
        const topCustomers = Object.entries(customerSpending).sort(([, a], [, b]) => b - a).slice(0, 5).map(([name, total]) => ({ name, total: total.toFixed(2) }));
            
        const hourCounts = Array(24).fill(0);
        orders.forEach(order => { const hour = new Date(order.created_at).getHours(); hourCounts[hour]++; });
        const peakHours = hourCounts.map((count, hour) => ({ hour, count })).sort((a,b) => b.count - a.count);

        const totalRevenue = orders.reduce((sum, order) => sum + parseFloat(order.totalPrice), 0);
        
        res.status(200).json({
            totalOrders: orders.length,
            totalRevenue: totalRevenue.toFixed(2),
            topItems,
            topCustomers,
            peakHours,
        });
    } catch (error) {
        console.error('Analytics Error:', error.message);
        res.status(500).json({ error: "Failed to fetch analytics." });
    }
});


// --- Helper Function to Send Notification ---
async function sendNotification(userId, payload) {
    if (!vapidPublicKey) {
        console.log('Skipping push notification, VAPID keys not set.');
        return; // Don't try if keys aren't set
    }

    try {
        const { data: subscriptions, error } = await supabase
            .from('push_subscriptions')
            .select('subscription')
            .eq('user_id', userId);

        if (error) throw new Error(`Error fetching subscriptions: ${error.message}`);
        if (!subscriptions || subscriptions.length === 0) {
            console.log(`No push subscriptions found for user ${userId}.`);
            return;
        }

        const notificationPayload = JSON.stringify(payload);
        const promises = subscriptions.map(sub => 
            webpush.sendNotification(sub.subscription, notificationPayload)
                .catch(err => {
                    if (err.statusCode === 410) {
                        console.log('Subscription has expired or is no longer valid. Deleting.');
                        return supabase
                            .from('push_subscriptions')
                            .delete()
                            .eq('subscription->>endpoint', sub.subscription.endpoint);
                    } else {
                        console.error('Failed to send push notification:', err.message);
                    }
                })
        );
        await Promise.all(promises);

    } catch (error) {
        console.error('Error sending notification:', error.message);
    }
}

module.exports = router;

