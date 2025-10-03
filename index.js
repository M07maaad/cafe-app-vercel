// هذا هو الملف الرئيسي في جذر المشروع

const express = require('express');
const path = require('path');
const apiRoutes = require('./api/index.js');

const app = express();
const PORT = process.env.PORT || 3001;

// استخدم الراوتر الخاص بالـ API لكل الطلبات التي تبدأ بـ /api
app.use('/api', apiRoutes);

// قدم الملفات الثابتة (HTML/CSS/JS) من مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// لأي طلب آخر لا يتطابق مع ما سبق، أرجع له ملف index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;

