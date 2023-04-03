const fs = require('fs');
const readline = require('readline');
const {google} = require('googleapis');
const {promisify} = require('util');
const {PubSub} = require('@google-cloud/pubsub');


const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'token.json';
const credentials = require('./credentials.json');

async function main() {
    try {
        // Load the client secrets from a local file

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        // Authorize with Google Drive API using client ID and client secret
        const auth = await authorize(rl, credentials);
        console.log('Authorization successful!');
        console.log("\n");
        let answer;
        while (answer !== 'exit') {
            // Prompt user for action
            answer = await new Promise(resolve => {
                rl.question('What do you want to do? (list/download/users/watch/exit) ', resolve);
            });

            switch (answer) {
                case 'list':
                    await listFiles(auth);
                    break;
                case 'download':
                    const fileId = await new Promise(resolve => {
                        rl.question('Enter the file ID: ', resolve);
                    });
                    await downloadFile(auth, fileId);
                    console.log('File downloaded.');
                    break;
                case 'users':
                    const fileId2 = await new Promise(resolve => {
                        rl.question('Enter the file ID: ', resolve);
                    });
                    await listFileUsers(auth, fileId2);
                    break;
                case 'watch':
                    const fileId3 = await new Promise(resolve => {
                        rl.question('Enter the file ID: ', resolve);
                    });
                    await watchFile(auth, fileId3);
                    break;
                case 'exit':
                    console.log('Exiting...');
                    break;
                default:
                    console.log('Invalid option.');
                    break;
            }
        }
        rl.close();
    } catch (error) {
        console.error(error);
    }
}

async function authorize(rl) {
    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(
        client_id, client_secret, redirect_uris[0]);

    try {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } catch (err) {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
        });
        console.log('Authorize this app by visiting this url:', authUrl);

        const code = await new Promise((resolve, reject) => {
            rl.question('Enter the code from that page here: ', (code) => {
                resolve(code);
            });
        });

        const token = await oAuth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token.tokens));
        oAuth2Client.setCredentials(token.tokens);
    }

    return oAuth2Client;
}

async function listFiles(auth) {
    try {
        const drive = google.drive({version: 'v3', auth});
        const res = await drive.files.list({
            pageSize: 10,
            fields: 'nextPageToken, files(id, name)',
        });
        const files = res.data.files;
        if (files.length) {
            console.log('Files:');
            files.forEach((file) => {
                console.log(`${file.name} (${file.id})`);
            });
        } else {
            console.log('No files found.');
        }
    } catch (err) {
        console.error('Error listing files:', err);
    }
}

// Download a file from the user's Google Drive
async function downloadFile(auth, fileId) {
    try {
        const drive = google.drive({version: 'v3', auth});
        const res = await drive.files.get({fileId, alt: 'media'}, {responseType: 'stream'});
        const dest = fs.createWriteStream(`./${fileId}.pdf`);
        res.data
            .on('end', () => {
                console.log('File download complete.');
            })
            .on('error', (err) => {
                console.error('Error downloading file:', err);
            })
            .pipe(dest);
    } catch (err) {
        console.error('Error retrieving file:', err);
    }
}

// List all users who have access to a file
async function listFileUsers(auth, fileId) {
    try {
        const drive = google.drive({version: 'v3', auth});
        const res = await drive.permissions.list({
            fileId: fileId,
            fields: 'permissions(displayName,emailAddress,role)',
        });
        const permissions = res.data.permissions;
        console.log('Users with access to file:');
        permissions.forEach(permission => {
            console.log(`${permission.displayName} (${permission.emailAddress}) - ${permission.role}`);
        });
    } catch (error) {
        console.error('Error listing file users:', error.message);
    }
}

// Watch for changes to a file in real time
async function watchFile(auth, fileId) {
    const topicName = 'g-drive-changes';
    const subscriptionName = 'g-drive-changes-sub';
    const projectId = credentials.projectId;
    const drive = google.drive({ version: 'v3', auth });

    const pubsubClient = new PubSub({
        projectId: projectId,
        keyFilename: 'key.json'
    });


    try {
        const [topic] = await pubsubClient.createTopic(topicName);
        console.log(`Topic ${topic.name} created.`);
    } catch (err) {
        if (err.code !== 6) {
            console.error('Error creating Pub/Sub topic:', err);
            return;
        }
        console.log(`Topic ${topicName} already exists.`);
    }

    try {
        const [subscription] = await pubsubClient.subscription(subscriptionName).get();
        console.log(`Subscription ${subscriptionName} already exists.`);
    } catch (err) {
        if (err.code === 5) {
            const [subscription] = await pubsubClient
                .topic(topicName)
                .createSubscription(subscriptionName);
            console.log(`Subscription ${subscription.name} created.`);
        } else {
            console.error('Error creating Pub/Sub subscription:', err);
            return;
        }
    }

    let pageToken = null;

    while (true) {
        try {
            const response = await drive.changes.list({
                pageToken: pageToken,
                spaces: 'drive',
                fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(name,owners))',
                pageSize: 1000,
            });
            const changes = response.data.changes;
            if (changes && changes.length > 0) {
                console.log('Changes found:');
                for (const change of changes) {
                    if (change.fileId === fileId) {
                        if (change.removed) {
                            console.log(`File ${change.file.name} was removed from the drive.`);
                        } else {
                            console.log(`File ${change.file.name} was modified.`);
                            console.log(`New owners: ${change.file.owners.map((owner) => owner.displayName).join(', ')}`);
                        }
                    }
                }
            }
            pageToken = response.data.nextPageToken;
            await updateStartPageToken(response.data.newStartPageToken);
        } catch (err) {
            console.error('Error while watching changes:', err);
            await new Promise((resolve) => setTimeout(resolve, 5000)); // wait for 5 seconds before retrying
        }
    }
}


main();