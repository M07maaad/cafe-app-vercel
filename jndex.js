// هذا هو الملف الرئيسي الجديد في جذر المشروع
// وهو نقطة الدخول للتطبيق بأكمله على Vercel

const express = require('express');
const path = require('path');
const apiRoutes = require('./api/index.js'); // استيراد ملف الـ API

const app = express();

// 1. استخدم الراوتر الخاص بالـ API لكل الطلبات التي تبدأ بـ /api
app.use('/api', apiRoutes);

// 2. قدم الملفات الثابتة (HTML/CSS/JS) من مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// 3. لأي طلب آخر لا يتطابق مع ما سبق، أرجع له ملف الواجهة الأمامية
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Vercel يتولى تشغيل الخادم، لذلك لا نحتاج إلى app.listen
module.exports = app;
