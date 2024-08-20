require('dotenv/config');
let {history} = require('./history/chatHistory');
const discord = require("discord.js");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const fs = require("fs");
const {join, dirname} = require("node:path");
const axios = require("axios");
const {GoogleAIFileManager} = require("@google/generative-ai/server");

const MODEL = "gemini-1.5-flash";
const API_KEY = process.env.API_KEY ?? process.env.API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN ?? process.env.BOT_TOKEN;
// const CHANNEL_ID = process.env.CHANNEL_ID ?? process.env.CHANNEL_ID;
const fileManager = new GoogleAIFileManager(API_KEY);
const ai = new GoogleGenerativeAI(API_KEY);
const model = ai.getGenerativeModel({model: MODEL});
const client = new discord.Client({
    intents: Object.keys(discord.GatewayIntentBits),
});

let mimeType;
let fileName;
let discordChannelId = '';

const imageTypes = ['jpg', 'png', 'webp', 'heic', 'heif'];
const pdfType = 'application/pdf';

// let botAuthorId = '';


async function downloadAttachment(url, filePath) {
    const dir = dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }

    const response = await axios({
        url, responseType: 'stream',
    });
    return new Promise((resolve, reject) => {
        response.data.pipe(fs.createWriteStream(filePath))
            .on('finish', () => resolve())
            .on('error', (e) => reject(e));
    });
}

function isAICategory(channel) {
    const categoryName = 'AI';
    const isThread = [10, 11, 12]
    if (channel.parent?.type === 4 && channel.parent?.name === categoryName) {
        return true;
    } else if (isThread.includes(channel.type) && channel.parent?.parent.name === categoryName) {
        return true;
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

client.on("ready", async () => {
    console.log("HMP Bot is ready!");
});

client.on('guildMemberAdd', member => {
    const welcomeMessage = `Hello, ${member.user.username}! \nWelcome to the HMP AI server! If you have any questions or need assistance, feel free to ask me anything 🙂.`;
    const channel = member.guild.channels.cache.find(ch => ch.name === 'general');

    if (channel) channel.send(welcomeMessage);
});

client.on("messageCreate", async (message) => {
    let result;
    let filePath = '';
    const categoryAI = isAICategory(message.channel);

    if (categoryAI) {
        discordChannelId = message.channel.isThread() ? !message.author.bot ? message.channel.id : discordChannelId : message.channel.id;
        // botAuthorId = !botAuthorId && message.author.bot?  message.author.id : botAuthorId;

        const existingAuthor = history.find(chat => chat.channelId === discordChannelId);
        let attachmentParts = [];

        if (!existingAuthor) {
            const newAuthorObject = {
                channelId: discordChannelId, chatHistory: []
            };
            history.push(newAuthorObject);
        }

        const tempDir = join('temp');
        const chatHistory = history.find(chat => chat.channelId === discordChannelId).chatHistory;
        const chat = model.startChat({
            history: chatHistory, generationConfig: {
                maxOutputTokens: 1000, temperature: 2.0,
            },
        });

        for (const attachment of message.attachments.values()) {
            fileName = attachment.name;
            mimeType = attachment.contentType;
            const fileType = attachment.url.split('/').pop().split('?')[0].split('.').pop();
            const attachmentFolder = imageTypes.includes(fileType) ? "images/" : mimeType === pdfType ? 'pdfs/' : 'attachments/';
            filePath = join(tempDir, attachmentFolder, fileName);

            if (mimeType !== pdfType || (mimeType === pdfType && message.channel.isThread())) {
                await downloadAttachment(attachment.url, filePath)

                if (mimeType !== pdfType) {
                    try {
                        const attachmentFile = {
                            inlineData: {
                                data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
                                mimeType: mimeType,
                            },
                        };

                        chatHistory.find(chat => chat.role === 'user')?.parts.push(attachmentFile);
                        const dbAttachments = chatHistory.find(chat => chat.role === 'user')?.parts.filter(obj => 'inlineData' in obj);

                        if (dbAttachments) {
                            attachmentParts.push(...dbAttachments);
                        } else {
                            attachmentParts.push(attachmentFile)
                        }


                    } catch (error) {
                        console.error('Error processing attachment:', error);
                    }
                }

            }
        }
        try {
            if (message.author.bot) return;
            if (message.attachments.size > 0) {
                if (mimeType === pdfType) {
                    if (message.channel.isThread()) {
                        const uploadResponse = await fileManager.uploadFile(filePath, {
                            mimeType: mimeType,
                            displayName: fileName,
                        });

                        // delete the downloaded attachment
                        fs.unlinkSync(filePath);

                        result = await chat.sendMessageStream([
                            {
                                fileData: {
                                    mimeType: uploadResponse.file.mimeType,
                                    fileUri: uploadResponse.file.uri
                                }
                            },
                        ]);
                    } else {
                        await message.reply({
                            content: 'If you want me to tackle a PDF, just start a new thread and toss it in—I\'ll put on my reading glasses and dive right in! 😎📄',
                        });
                    }
                } else {
                    result = await chat.sendMessageStream([message.cleanContent, ...attachmentParts]);

                    // delete the downloaded attachment
                    fs.unlinkSync(filePath);
                }
            } else {
                result = await chat.sendMessageStream(message.cleanContent);
            }

            if (result) {
                let sentMessage = await message.reply({
                    content: '_ _',
                });
                let accumulatedText = '';
                let messageCharacterLimit = 2000;

                for await (const chunk of result?.stream) {
                    const chunkText = chunk.text();
                    accumulatedText += chunkText;

                    if (accumulatedText.trim()) {
                        if (accumulatedText.length < messageCharacterLimit) {
                            await sentMessage.edit({content: accumulatedText});
                        } else {
                            sentMessage = await message.reply({
                                content: chunkText,
                            });
                            accumulatedText = chunkText;
                        }
                    } else {
                        console.log('Warning: Attempting to send or edit with empty content.');
                    }
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


            // Logging chat history to JSON format
            // console.log("Final history array:");
            // console.log(JSON.stringify(history, null, 2));

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
            if (e.message.includes('SAFETY')) {
                await message.reply({
                    content: "Whoa there, déjà vu! You've asked that question so many times, even my circuits are getting dizzy. I need a breather—how about you wait a moment and try again, or hit me with a new question before I start having a meltdown! 😅",
                });
            }
        }
    }
});

// Remove channel history, when channel is deleted
client.on('channelDelete', channel => {
    history = history.filter(item => item.channelId !== channel.id);
});

// Remove thread history, when thread is deleted
client.on('threadDelete', thread => {
    history = history.filter(item => item.channelId !== thread.id);
});
