require('dotenv/config');
const {chatHistory, addEntry} = require('./history/chatHistory');

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

let imageParts = [];
let result;
let mimeType;
const imageTypes = ['jpg', 'png', 'webp', 'heic', 'heif'];

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
        await downloadImage(url, filepath);

        return filepath;
    } else {
        return false;
    }
}

const chat = model.startChat({
    history: chatHistory,
    generationConfig: {
        maxOutputTokens: 1000,
        temperature: 2.0,
    },
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

    for (const attachment of message.attachments.values()) {
        await processImage(attachment.url).then(filepath => {
            if (filepath === false) {
                message.reply({
                    content: `The image format is invalid. Please provide one of the following image types: ${imageTypes.join(', ')}.`,
                });
            } else {
                try {

                    const image = {
                        inlineData: {
                            data: Buffer.from(fs.readFileSync(filepath)).toString("base64"),
                            mimeType: mimeType,
                        },
                    };

                    chatHistory.find(chat => chat.role === 'user')?.parts.push(image);

                    imageParts.push(image)

                    fs.unlinkSync(filepath);
                } catch (error) {
                    console.error('Error processing image:', error);
                }
            }
        })
    }
    try {
        if (message.author.bot) return;
        if (message.channel.id !== CHANNEL_ID) return;

        if (message.attachments.size > 0) {
            result = await model.generateContentStream([message.cleanContent, ...imageParts]);
        } else {
            result = await chat.sendMessageStream(message.cleanContent);
        }

        let sentMessage = await message.reply({
            content: '_ _',
        });
        let accumulatedText = '';

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            accumulatedText += chunkText;

            if (accumulatedText.trim()) {
                await sentMessage.edit({content: accumulatedText});
            } else {
                console.log('Warning: Attempting to send or edit with empty content.');
            }
        }

        // CHAT HISTORY
        chatHistory.map(item => {
            console.log(`${item.role}: `, item.parts)
        })

    } catch
        (e) {
        console.log('Gemini AI Error: ', e);
        if (e.status === 503) {
            await message.reply({
                content: `Whoa there, partner! I’m only equipped to handle 15 requests per minute. Give me a moment to catch my breath, and then feel free to try again. Thanks for your patience!`,
            });
        }
        if (e.status === 429) {
            await message.reply({
                content: "Whoa there! I’m flattered, but you’ve hit the jackpot with questions—my quota’s been maxed out!",
            });
        }
        if (e.message.includes('RECITATION')) {
            await message.reply({
                content: "Please re-phrase your question",
            });
        }
    }
});
