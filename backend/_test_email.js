const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  auth: { user: 'noreply.coinflip.support@gmail.com', pass: 'ictpowyhoeyykkzn' }
});
transporter.sendMail({
  from: '"CoinFlip Game" <noreply.coinflip.support@gmail.com>',
  to: 'noreply.coinflip.support@gmail.com',
  subject: 'Test OTP - CoinFlip',
  html: '<h2>Test</h2><p>Your OTP is: <strong>123456</strong></p>'
}).then(info => console.log('Sent:', info.messageId))
  .catch(e => console.log('Error:', e.message));
