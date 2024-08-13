require('dotenv/config');
const {history} = require('./history/chatHistory');

const discord = require("discord.js");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const fs = require("fs");
const {join, dirname} = require("node:path");
const axios = require("axios");
const {d} = require("caniuse-lite/dist/lib/supported");

const MODEL = "gemini-1.5-flash";
const API_KEY = process.env.API_KEY ?? process.env.API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN ?? process.env.BOT_TOKEN;
// const CHANNEL_ID = process.env.CHANNEL_ID ?? process.env.CHANNEL_ID;

const ai = new GoogleGenerativeAI(API_KEY);
const model = ai.getGenerativeModel({model: MODEL});

const client = new discord.Client({
    intents: Object.keys(discord.GatewayIntentBits),
});

let result;
let mimeType;
const imageTypes = ['jpg', 'png', 'webp', 'heic', 'heif'];
// let botAuthorId = '';
let discordChannelId = '';


function getFilenameFromUrl(url) {
    const fileName = url.split('/').pop().split('?')[0];
    const fileType = fileName.split('.').pop();

    if (imageTypes.includes(fileType)) {
        mimeType = "image/" + fileType
    }

    return fileName;
}

async function downloadImage(url, filepath) {
    const dir = dirname(filepath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }

    const response = await axios({
        url, responseType: 'stream',
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
    const filepath = join(tempDir, filename);

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
    discordChannelId = message.channel.isThread() ? !message.author.bot ? message.channel.id : discordChannelId : message.channel.id;
    // botAuthorId = !botAuthorId && message.author.bot?  message.author.id : botAuthorId;

    const existingAuthor = history.find(chat => chat.channelId === discordChannelId);
    let imageParts = [];


    if (!existingAuthor) {
        const newAuthorObject = {
            channelId: discordChannelId, chatHistory: []
        };
        history.push(newAuthorObject);
    }

    const chatHistory = history.find(chat => chat.channelId === discordChannelId).chatHistory;

    const chat = model.startChat({
        history: chatHistory, generationConfig: {
            maxOutputTokens: 1000, temperature: 2.0,
        },
    });

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
                            data: Buffer.from(fs.readFileSync(filepath)).toString("base64"), mimeType: mimeType,
                        },
                    };

                    chatHistory.find(chat => chat.role === 'user')?.parts.push(image);
                    const dbImages = chatHistory.find(chat => chat.role === 'user')?.parts.filter(obj => 'inlineData' in obj);

                    if (dbImages) {
                        imageParts.push(...dbImages);
                    } else {
                        imageParts.push(image)
                    }

                    // delete the downloaded image
                    fs.unlinkSync(filepath);
                } catch (error) {
                    console.error('Error processing image:', error);
                }
            }
        })
    }
    try {
        if (message.author.bot) return;
        if (message.attachments.size > 0) {
            result = await chat.sendMessageStream([message.cleanContent, ...imageParts]);
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
        history.map(chat => {
            chat.chatHistory.map(item => {
                // console.log('ITEM.role:', item.role, 'ITEM.parts:', item.parts)
            })
        })

        // chatHistory.map(chat => {
        //     console.log('chat', chat)
        //     console.log('chat.role:::', chat.role, 'chatHistory::::::', chat.parts)
        // });


        console.log("Final history array:");
        console.log(JSON.stringify(history, null, 2));

    } catch (e) {
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
                content: "'Your prompt has encountered an error:\\n' +\n" + "                '\\n' +\n" + "                'This error originates from Google\\'s AI system, specifically the generative AI model that is being used. It is designed to avoid plagiarism and ensure ethical and responsible AI usage.\\n' +\n" + "                '\\n' +\n" + "                'Possible reasons for the error:\\n' +\n" + "                '\\n' +\n" + "                'Your request is too specific and asks for a direct copy of existing content: For example, asking for a summary of a specific article or book.\\n' +\n" + "                'The request is phrased in a way that encourages the model to simply rephrase existing information.\\n' +\n" + "                'You are trying to generate content that is too close to a copyrighted work.\\n' +\n" + "                '\\n' +\n" + "                'How to avoid this error:\\n' +\n" + "                '\\n' +\n" + "                'Be more creative with your requests: Ask open-ended questions, encourage the model to provide original insights, and ask for different perspectives.\\n' +\n" + "                'Provide more context: Explain the purpose of your request and what you want the model to achieve.\\n' +\n" + "                'Avoid asking for direct summaries or rephrasings of existing content.\\n' +\n" + "                '\\n' +\n" + "                'Remember that the Google AI system is constantly evolving, and the specific reasons for this error may vary. If you encounter this error, it\\'s best to review your request and try to rephrase it in a way that encourages original and creative responses.'",
            });
        }
    }
});
