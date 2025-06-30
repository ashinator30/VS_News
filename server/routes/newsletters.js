import { Router } from 'express';
import puppeteer from 'puppeteer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { format } from 'date-fns';
import sgMail from '@sendgrid/mail';
import Newsletter from '../models/newsletter.model.js';
import User from '../models/user.model.js';
import auth from '../middleware/auth.js';
import Notification from '../models/notification.model.js';

const router = Router();

// --- Initialize SendGrid ---
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    console.log("✅ SendGrid client initialized.");
} else {
    console.warn("⚠️ SendGrid API Key not found. Email sending will be disabled.");
}

// --- Initialize Gemini AI (used for article summaries) ---
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

/**
 * Generates the complete HTML for the newsletter using a professional, static template.
 * @param {string} title - The title of the newsletter.
 * @param {string} category - The CoE/category of the newsletter.
 * @param {Array} articles - The array of summarized articles.
 * @returns {string} The complete HTML for the newsletter.
 */
const generateNewsletterHtml = (title, category, articles) => {
    // --- Article Blocks ---
    const articleBlocks = articles.map(article => `
        <div class="article" style="margin-bottom: 25px; padding-bottom: 25px; border-bottom: 1px solid #eeeeee;">
            ${article.imageUrl ? `<img src="${article.imageUrl}" alt="${article.title}" style="max-width: 100%; height: auto; border-radius: 8px; margin-bottom: 15px;">` : ''}
            <h3 style="font-size: 20px; color: #333333; margin-top: 0; margin-bottom: 5px;">
                <a href="${article.originalUrl}" target="_blank" style="text-decoration: none; color: #0056b3;">${article.title}</a>
            </h3>
            <p style="font-size: 12px; color: #666666; margin-bottom: 15px;">
                Source: <em>${article.sourceName}</em>
            </p>
            <p style="font-size: 16px; color: #555555; line-height: 1.6;">
                ${article.summary}
            </p>
        </div>
    `).join('');

    // --- Main HTML Template ---
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
    </head>
    <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f4f4;">
            <tr>
                <td align="center">
                    <table width="600" border="0" cellspacing="0" cellpadding="20" style="background-color: #ffffff; margin: 20px 0; max-width: 600px;">
                        <tr>
                            <td align="center" style="background-color: #00447c; padding: 30px 20px; color: #ffffff; border-radius: 8px 8px 0 0;">
                                <h1 style="margin: 0; font-size: 28px;">${category} Newsletter</h1>
                                <p style="margin: 5px 0 0; font-size: 16px;">${title}</p>
                            </td>
                        </tr>
                        <tr>
                            <td align="center" style="padding: 10px 20px; background-color: #eeeeee; font-size: 14px; color: #555555;">
                                ${format(new Date(), 'MMMM d, yyyy')}
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 30px 20px;">
                                ${articleBlocks}
                            </td>
                        </tr>
                        <tr>
                            <td align="center" style="padding: 20px; font-size: 12px; color: #aaaaaa; border-top: 1px solid #eeeeee;">
                                <p>&copy; ${new Date().getFullYear()} Your Company. All rights reserved.</p>
                                <p>This is an automated newsletter. Please do not reply.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;
};


// GET all newsletters for the logged-in admin's categories
router.get('/', auth, async (req, res) => {
  try {
    const admin = await User.findById(req.user);
    if (!admin || !admin.categories || admin.categories.length === 0) {
        return res.json([]);
    }
    const newsletters = await Newsletter.find({ category: { $in: admin.categories } });
    res.json(newsletters);
  } catch (err) {
    res.status(500).json({ message: 'Server error fetching newsletters.' });
  }
});


// POST to generate, save, and send the new PDF
router.post('/generate-and-save', auth, async (req, res) => {
    try {
        const { articles, title, category } = req.body;
        console.log(`[PDF LOG] Received request for newsletter: "${title}"`);

        if (!articles || articles.length === 0 || !title || !category) {
            return res.status(400).json({ message: 'Title, category, and articles are required.' });
        }

        // 1. Generate HTML using the new static template function
        console.log("[PDF LOG] Generating HTML with the static template...");
        const generatedHtml = generateNewsletterHtml(title, category, articles);
        console.log("[PDF LOG] Successfully generated HTML.");

        // 2. Convert HTML to PDF with Puppeteer
        const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(generatedHtml, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();
        console.log("[PDF LOG] Successfully converted HTML to PDF buffer.");

        // 3. Create and Save New Newsletter to DB
        const newNewsletter = new Newsletter({
            title,
            category,
            articles: articles.map(a => a._id),
            status: 'Not Sent',
            pdfContent: {
                data: Buffer.from(pdfBuffer),
                contentType: 'application/pdf'
            }
        });
        await newNewsletter.save();
        console.log(`[PDF LOG] Successfully saved newsletter with ID: ${newNewsletter._id}`);
        
        // 4. Send the generated PDF back to the client
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${title.replace(/\s/g, '_')}.pdf"`);
        res.send(pdfBuffer);

    } catch (err) {
        console.error("--- PDF GENERATION/SAVE FAILED ---", err);
        res.status(500).json({ message: 'Failed to generate and save PDF. Check server logs for details.' });
    }
});

// GET to download a saved PDF
router.get('/:id/download', auth, async (req, res) => {
    try {
        const newsletter = await Newsletter.findById(req.params.id);
        if (!newsletter || !newsletter.pdfContent || !newsletter.pdfContent.data) {
            return res.status(404).send('PDF not found.');
        }
        res.setHeader('Content-Type', newsletter.pdfContent.contentType);
        res.setHeader('Content-Disposition', `inline; filename="${newsletter.title.replace(/\s/g, '_')}.pdf"`);
        res.send(newsletter.pdfContent.data);
    } catch (err) {
        res.status(500).send('Server error while retrieving PDF.');
    }
});

// PATCH to update a newsletter's status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const updatedNewsletter = await Newsletter.findByIdAndUpdate(req.params.id, { status }, { new: true });
    res.json(updatedNewsletter);
  } catch (err) {
    res.status(500).json({ message: 'Server error updating status.' });
  }
});

// DELETE a newsletter
router.delete('/:id', auth, async (req, res) => {
  try {
    const newsletter = await Newsletter.findByIdAndDelete(req.params.id);
    if (!newsletter) {
      return res.status(404).json({ message: 'Newsletter not found.' });
    }
    res.json({ message: 'Newsletter deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error while deleting newsletter.' });
  }
});

// POST to send the newsletter to users
router.post('/:id/send', auth, async (req, res) => {
    try {
        const { userIds } = req.body;
        if (!userIds || userIds.length === 0) {
            return res.status(400).json({ message: 'No recipients selected.' });
        }
        const newsletter = await Newsletter.findById(req.params.id);
        if (!newsletter) {
            return res.status(404).json({ message: 'Newsletter not found.' });
        }
        if (process.env.SENDGRID_API_KEY) {
            const recipients = await User.find({ '_id': { $in: userIds } }).select('email name');
            if (recipients.length > 0) {
                 const msg = {
                    to: recipients.map(r => r.email),
                    from: { name: 'NewsLetterAI', email: process.env.FROM_EMAIL },
                    subject: `Your New ${newsletter.category} Newsletter: ${newsletter.title}`,
                    html: `
                    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
                        <h2>Hello,</h2>
                        <p>Your new issue of the <strong>${newsletter.category}</strong> newsletter, titled "<strong>${newsletter.title}</strong>," is here!</p>
                        <p>We've curated the latest news and insights for you. You can find the full newsletter attached to this email.</p>
                        <p>Happy reading!</p>
                        <br>
                        <p>Best regards,</p>
                        <p><strong>The NewsLetterAI Team</strong></p>
                    </div>
                    `,
                    attachments: [{
                        content: newsletter.pdfContent.data.toString('base64'),
                        filename: `${newsletter.title.replace(/\s/g, '_')}.pdf`,
                        type: 'application/pdf',
                        disposition: 'attachment',
                    }],
                };
                await sgMail.send(msg);
            }
        }
        newsletter.status = 'sent';
        newsletter.recipients.addToSet(...userIds);
        await newsletter.save();
        
        try {
            const notifications = userIds.map(userId => ({
                user: userId,
                newsletter: newsletter._id,
                message: `You received the "${newsletter.title}" newsletter.`,
            }));
            if (notifications.length > 0) {
                await Notification.insertMany(notifications, { ordered: false });
            }
        } catch (notificationError) {
            console.error('CRITICAL: Failed to create notifications, but email was sent.', notificationError);
        }
        res.json({ message: `Newsletter successfully sent to ${userIds.length} user(s).` });
    } catch (err) {
        console.error('A major error occurred in the /send route:', err);
        res.status(500).json({ message: 'Failed to send newsletter due to a server error.' });
    }
});

export default router;
