require('dotenv/config');

const discord = require("discord.js");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const fs = require("fs");
const {join} = require("node:path");
const axios = require("axios");

const MODEL = "gemini-1.5-flash";
const API_KEY = process.env.API_KEY ?? process.env.API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN ?? process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ?? process.env.CHANNEL_ID;

const ai = new GoogleGenerativeAI(API_KEY);
const model = ai.getGenerativeModel({model: MODEL});

const client = new discord.Client({
    intents: Object.keys(discord.GatewayIntentBits),
});

client.login(BOT_TOKEN).then(() => {
    console.log('Logged in successfully!');
})
    .catch(err => {
        console.error('Failed to login:', err);
    });

client.on("ready", () => {
    console.log("HMP Bot is ready!");
});

client.on('guildMemberAdd', member => {
    const welcomeMessage = `Hello, ${member.user.username}! \nWelcome to the HMP AI server! If you have any questions or need assistance, feel free to ask me anything 🙂.`;
    const channel = member.guild.channels.cache.find(ch => ch.name === 'general');

    if (channel) channel.send(welcomeMessage);
});

client.on("messageCreate", async (message) => {
    let discordImage;
    let image;
    let result;
    let mimeType;
    const imageTypes = ['jpg', 'png', 'webp', 'heic', 'heif'];

    for (const attachment of message.attachments.values()) {
        discordImage = attachment.url;
    }

    function getFilenameFromUrl(url) {
        const fileName = url.split('/').pop().split('?')[0];
        const fileType = fileName.split('.').pop();

        if (imageTypes.includes(fileType)) {
            mimeType = "image/" + fileType
        }

        return fileName;
    }

    async function downloadImage(url, filepath) {
        const response = await axios({
            url,
            responseType: 'stream',
        });
        return new Promise((resolve, reject) => {
            response.data.pipe(fs.createWriteStream(filepath))
                .on('finish', () => resolve())
                .on('error', (e) => reject(e));
        });
    }

    async function processImage(url) {
        const tempDir = join('temp');
        const filename = getFilenameFromUrl(url);
        const filepath = join(filename);

        if (mimeType) {
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
            }

            try {
                await downloadImage(url, filepath);

                image = {
                    inlineData: {
                        data: Buffer.from(fs.readFileSync(filepath)).toString("base64"),
                        mimeType: mimeType,
                    },
                };

                fs.unlinkSync(filepath);
            } catch (error) {
                console.error('Error processing image:', error);
            }
        } else {
            await message.reply({
                content: `The image format is invalid. Please provide one of the following image types: ${imageTypes.join(', ')}.`,
            });
        }
    }

    try {
        if (message.author.bot) return;
        if (message.channel.id !== CHANNEL_ID) return;

        if (discordImage) {
            await processImage(discordImage)
            result = await model.generateContent([message.cleanContent, image]);

        } else {
            result = await model.generateContent(message.cleanContent);
        }

        const response = await result?.response;

        if (message.content) {
            await message.reply({
                content: response?.text(),
            });
        }
    } catch (e) {
        console.log(e);
    }
});
