require('dotenv/config');
let {history} = require('./history/chatHistory');
const discord = require("discord.js");
const {GoogleGenerativeAI} = require("@google/generative-ai");
const fs = require("fs");
const {join, dirname} = require("node:path");
const axios = require("axios");
const {GoogleAIFileManager} = require("@google/generative-ai/server");
const {safetySettings} = require("./gemini/safetySettings");

const MODEL = "gemini-1.5-flash";
const API_KEY = process.env.API_KEY ?? process.env.API_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN ?? process.env.BOT_TOKEN;
const fileManager = new GoogleAIFileManager(API_KEY);
const ai = new GoogleGenerativeAI(API_KEY);

const imageTypes = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const pdfType = 'application/pdf';
let discordChannelId = '';
let model;

async function initializeBot() {
    const systemInstructions = await checkPersonality();

    model = await ai.getGenerativeModel({
        model: MODEL,
        safetySettings,
        systemInstruction: systemInstructions
    });

    console.log("Bot initialized:::", systemInstructions);
}

initializeBot().catch(error => {
    console.error("Error initializing bot:", error);
});
const client = new discord.Client({
    intents: Object.keys(discord.GatewayIntentBits),
});

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
    let mimeType;
    let fileName;
    let fileType;
    let sentMessage;

    const categoryAI = isAICategory(message.channel);

    if (categoryAI) {
        if (message.author.bot || message.system) return;

        let attachmentParts = [];
        let pdfInChannel = false;

        discordChannelId = message.channel.isThread() ? !message.author.bot ? message.channel.id : discordChannelId : message.channel.id;
        const existingAuthor = message.channel.isThread()
            ? history.find(chat => chat.channelId === discordChannelId)
            : await getChatHistory(discordChannelId);

        if (!existingAuthor) {
            if (message.channel.isThread()) {
                const newAuthorObject = {
                    channelId: discordChannelId, chatHistory: []
                };
                history.push(newAuthorObject);
            } else {
                await createNewChat(discordChannelId)
            }
        }

        const tempDir = join('temp');
        const chatHistory = message.channel.isThread()
            ? history.find(chat => chat.channelId === discordChannelId).chatHistory
            : existingAuthor?.chatHistory;


        const chat = model.startChat({
            history: chatHistory, generationConfig: {
                maxOutputTokens: 1000, temperature: 2.0,
            },
        });

        try {
            if (message.attachments.size > 0) {
                sentMessage = await message.reply({
                    content: 'Just a moment, processing your attachments...',
                });

                for (const attachment of message.attachments.values()) {
                    fileName = attachment.name;
                    mimeType = attachment.contentType;
                    fileType = mimeType.split('/').pop().split('?')[0].split('.').pop();
                    const attachmentFolder = imageTypes.includes(fileType) ? "images/" : mimeType === pdfType ? 'pdfs/' : 'attachments/';
                    filePath = join(tempDir, attachmentFolder, fileName);

                    if (mimeType === pdfType && !message.channel.isThread()) {
                        if (sentMessage) {
                            await sentMessage.edit({content: 'If you want me to tackle a PDF, just start a new thread and toss it in—I\'ll put on my reading glasses and dive right in! 😎📄'});
                        } else {
                            await message.reply({
                                content: 'If you want me to tackle a PDF, just start a new thread and toss it in—I\'ll put on my reading glasses and dive right in! 😎📄',
                            });
                        }
                        pdfInChannel = true;
                        break;
                    } else {
                        await downloadAttachment(attachment.url, filePath)

                        const uploadResponse = await fileManager.uploadFile(filePath, {
                            mimeType: mimeType,
                            displayName: fileName,
                        });

                        const fetchedFile = {
                            fileData: {
                                mimeType: uploadResponse.file.mimeType,
                                fileUri: uploadResponse.file.uri
                            }
                        }
                        attachmentParts.push(fetchedFile)

                        // delete the downloaded attachment
                        fs.unlinkSync(filePath);
                    }
                }

                if (!pdfInChannel) {
                    result = await chat.sendMessageStream([message.cleanContent, ...attachmentParts]);
                }
            } else {
                result = await chat.sendMessageStream(message.cleanContent);
            }

            if (result) {
                let accumulatedText = '';
                let messageCharacterLimit = 2000;

                if (mimeType === pdfType) {
                    await sentMessage.edit({content: 'Feel free to ask me anything about the PDF you provided — I\'m here to help!'});
                } else {
                    let i = 0;
                    for await (const chunk of result?.stream) {
                        const chunkText = chunk.text();
                        accumulatedText += chunkText;

                        if (i === 0 && message.attachments.size === 0) {
                            sentMessage = await message.reply({
                                content: chunkText,
                            });
                        }
                        i++;

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

                    if (!message.channel.isThread()) {
                        const newEntries = [
                            {
                                role: 'user',
                                parts: [{text: message.cleanContent}]
                            },
                            {
                                role: 'model',
                                parts: [{text: accumulatedText}]
                            }]

                        await updateChatHistory(discordChannelId, newEntries)
                    }
                }
            }

            // CHAT HISTORY LOGGING
            // history.map(chat => {
            //     chat.chatHistory.map(item => {
            //         console.log('ITEM.role:', item.role, 'ITEM.parts:', item.parts)
            //     })
            // })

            // chatHistory.map(chat => {
            //     // console.log('chat', chat)
            //     console.log('chat.role:::', chat.role, 'chatHistory::::::', chat.parts)
            // });


            // Logging chat history to JSON format
            // console.log("Final history array:");
            // console.log(JSON.stringify(chatHistory, null, 2));

        } catch (e) {
            console.log('Gemini AI Error: ', e);

            // Too many questions per minute
            if (e.status === 503) {
                await message.reply({
                    content: `Whoa there, partner! I’m only equipped to handle 15 requests per minute. Give me a moment to catch my breath, and then feel free to try again. Thanks for your patience!`,
                });
            }

            // No more tokens available
            if (e.status === 429) {
                await message.reply({
                    content: "Whoa there! I’m flattered, but you’ve hit the jackpot with questions—my quota’s been maxed out!",
                });
            }

            // NSFW or unethical content
            if (e.message.includes('RECITATION')) {
                await message.reply({
                    content: "'Your prompt has encountered an error:\\n' +\n" + "                '\\n' +\n" + "                'This error originates from Google\\'s AI system, specifically the generative AI model that is being used. It is designed to avoid plagiarism and ensure ethical and responsible AI usage.\\n' +\n" + "                '\\n' +\n" + "                'Possible reasons for the error:\\n' +\n" + "                '\\n' +\n" + "                'Your request is too specific and asks for a direct copy of existing content: For example, asking for a summary of a specific article or book.\\n' +\n" + "                'The request is phrased in a way that encourages the model to simply rephrase existing information.\\n' +\n" + "                'You are trying to generate content that is too close to a copyrighted work.\\n' +\n" + "                '\\n' +\n" + "                'How to avoid this error:\\n' +\n" + "                '\\n' +\n" + "                'Be more creative with your requests: Ask open-ended questions, encourage the model to provide original insights, and ask for different perspectives.\\n' +\n" + "                'Provide more context: Explain the purpose of your request and what you want the model to achieve.\\n' +\n" + "                'Avoid asking for direct summaries or rephrasings of existing content.\\n' +\n" + "                '\\n' +\n" + "                'Remember that the Google AI system is constantly evolving, and the specific reasons for this error may vary. If you encounter this error, it\\'s best to review your request and try to rephrase it in a way that encourages original and creative responses.'",
                });
            }

            // If same prompt is sent too frequently
            if (e.message.includes('SAFETY')) {
                await message.reply({
                    content: "Whoa there! You've might've asked that question so many times that my circuits are getting dizzy.\n" + "I need a breather — either you're asking too frequently or it might be against my safety policy. How about giving me a moment and trying again, or hit me with a new question before I start glitching out😅!",
                });
            }
        }
    }
});

// Remove channel history, when channel is deleted
client.on('channelDelete', channel => {
    deleteChatHistory(channel.id).then(r =>
        console.log(`${r} (Channel name: ${channel.name})`)
    )
});

// Remove thread history, when thread is deleted
client.on('threadDelete', thread => {
    history = history.filter(item => item.channelId !== thread.id);
});

// Fetch Bot personality from database
async function checkPersonality() {
    let botResponseNature = [{
        botPersonality: ""
    }];
    const currentPersonality = await getBotPersonality();

    if (!currentPersonality.length > 0) {
        await createNewPersonality();
    } else {
        botResponseNature = currentPersonality;
    }
    return botResponseNature[0].botPersonality;
}

// Clean retrieved chat history to proper format
function removeDbGeneratedObjects(doc) {
    if (Array.isArray(doc)) {
        return doc.map(removeDbGeneratedObjects);
    } else if (doc && typeof doc === 'object') {
        const {_id, __v, ...rest} = doc; // Destructure _id and __v, leaving the rest of the fields
        return Object.keys(rest).reduce((acc, key) => {
            acc[key] = removeDbGeneratedObjects(rest[key]);
            return acc;
        }, {});
    } else {
        return doc;
    }
}

// DATABASE CALLS FOR CHATS

// Get chat from DB
async function getChatHistory(discordChannelId) {
    try {
        const response = await axios.get(`http://localhost:${process.env.DATA_PORT}/chats/${discordChannelId}`);
        const history = response.data;

        return removeDbGeneratedObjects(history);
    } catch (error) {
        console.error('Error fetching chat history:', error.message);
    }
}

// Create a new chat in DB
async function createNewChat(discordChannelId) {
    const newAuthorObject = {
        channelId: discordChannelId, chatHistory: []
    };
    try {
        await axios.post(`http://localhost:${process.env.DATA_PORT}/chats/`, newAuthorObject);
    } catch (error) {
        console.error('Error setting a new chat:', error.message);
    }
}


// Update chat
async function updateChatHistory(discordChannelId, newHistory) {
    try {
        const response = await axios.get(`http://localhost:3002/chats/${discordChannelId}`);
        const chat = response.data;
        const updatedHistory = chat.chatHistory.concat(newHistory);

        await axios.patch(`http://localhost:3002/chats/${discordChannelId}`, {chatHistory: updatedHistory});
    } catch (error) {
        console.error('Error updating chat:', error.response ? error.response.data : error.message);
    }
}

// Delete chat
async function deleteChatHistory(discordChannelId) {
    try {
        const response = await axios.delete(`http://localhost:3002/chats/${discordChannelId}`);
        return response.data.message;

    } catch (error) {
        console.error('Error updating chat:', error.response ? error.response.data : error.message);
    }
}

// DATABASE CALLS FOR BOT SETTINGS

// Get chat history from DB
async function getBotPersonality() {
    try {
        const response = await axios.get(`http://localhost:${process.env.DATA_PORT}/bots`);
        const personality = response.data;

        return personality;
    } catch (error) {
        console.error('Error fetching chat history:', error.message);
    }
}

// Create a new empty bot personality
async function createNewPersonality() {
    const createPersonality = {botPersonality: ""};
    try {
        await axios.post(`http://localhost:${process.env.DATA_PORT}/bots/`, createPersonality);
    } catch (error) {
        console.error('Error setting a new chat:', error.message);
    }
}
