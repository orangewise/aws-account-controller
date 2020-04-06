/*

CreateConnect Event:

{
  "properties": {
    "Domain": "9030bff7"
  }
}

ResetEmail Event:

{
  "email": "example7@awsaccounts.ian.mn"
}

*/

const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');
const AWS = require('aws-sdk');
const fs = require('fs');
const url = require('url');
var rp = require('request-promise');
var winston = require('winston');
var InternetMessage = require("internet-message");
var saml2 = require('saml2-js');

var LOG = winston.createLogger({
    level: process.env.LOG_LEVEL.toLowerCase(),
    transports: [
        new winston.transports.Console()
    ]
});

var s3 = new AWS.S3();
var ssm = new AWS.SSM();
var rekognition = new AWS.Rekognition();
var organizations = new AWS.Organizations();
var ses = new AWS.SES();
var eventbridge = new AWS.EventBridge();
var secretsmanager = new AWS.SecretsManager();

const CAPTCHA_KEY = process.env.CAPTCHA_KEY;
const MASTER_EMAIL = process.env.MASTER_EMAIL;
const ACCOUNTID = process.env.ACCOUNTID;

const sendcfnresponse = async (event, context, responseStatus, responseData, physicalResourceId, noEcho) => {
    var responseBody = JSON.stringify({
        Status: responseStatus,
        Reason: "See the details in CloudWatch Log Stream: " + context.logStreamName,
        PhysicalResourceId: physicalResourceId || context.logStreamName,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        NoEcho: noEcho || false,
        Data: responseData
    });
 
    LOG.debug("Response body:\n", responseBody);
 
    var https = require("https");
    var url = require("url");
 
    var parsedUrl = url.parse(event.ResponseURL);
    var options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: "PUT",
        headers: {
            "content-type": "",
            "content-length": responseBody.length
        }
    };
 
    await new Promise((resolve, reject) => {
        var request = https.request(options, function(response) {
            LOG.debug("Status code: " + response.statusCode);
            LOG.debug("Status message: " + response.statusMessage);
            resolve();
        });
     
        request.on("error", function(error) {
            LOG.warn("send(..) failed executing https.request(..): " + error);
            reject();
        });
     
        request.write(responseBody);
        request.end();
    });
}

const solveCaptcha = async (page, url) => {
    var captchaResult = "";

    if (process.env.CAPTCHA_STRATEGY == "Rekognition") {
        captchaResult = await solveCaptchaRekog(page, url);
    } else {
        captchaResult = await solveCaptcha2captcha(page, url);
    }

    return captchaResult;
};

const solveCaptchaRekog = async (page, url) => {
    var imgbody = await rp({ uri: url, method: 'GET', encoding: null }).then(res => {
        return res;
    });

    var code = null;
    
    await new Promise(function (resolve, reject) {
        rekognition.detectText({
            Image: {
                Bytes: Buffer.from(imgbody)
            }
        }, function(err, data) {
            LOG.debug(data);
            LOG.debug(err);

            if (data) {
                data.TextDetections.forEach(textDetection => {
                    var text = textDetection.DetectedText.replace(/\ /g, "");
                    if (text.length == 6) {
                        code = text;
                    }
                });
            }
            
            resolve();
        });
    });

    LOG.debug(code);

    if (!code) {
        await page.click('.refresh');
        await page.waitFor(5000);
    }

    return code;
}

const solveCaptcha2captcha = async (page, url) => {
    var imgbody = await rp({ uri: url, method: 'GET', encoding: null }).then(res => {
        return res;
    });

    var captcharef = await rp({ uri: 'http://2captcha.com/in.php', method: 'POST', body: JSON.stringify({
        'key': CAPTCHA_KEY,
        'method': 'base64',
        'body': "data:image/jpeg;base64," + Buffer.from(imgbody).toString('base64')
    })}).then(res => {
        LOG.debug(res);
        return res.split("|").pop();
    });;

    var captcharesult = '';
    var i = 0;
    while (!captcharesult.startsWith("OK") && i < 20) {
        await new Promise(resolve => { setTimeout(resolve, 5000); });

        var captcharesult = await rp({ uri: 'http://2captcha.com/res.php?key=' + CAPTCHA_KEY + '&action=get&id=' + captcharef, method: 'GET' }).then(res => {
            LOG.debug(res);
            return res;
        });

        i++;
    }

    return captcharesult.split("|").pop();
}

const uploadResult = async (url, data) => {
    await rp({ uri: url, method: 'PUT', body: JSON.stringify(data) });
}

const debugScreenshot = async (page) => {
    if (LOG.level == "debug") {
        let filename = Date.now().toString() + ".png";

        await page.screenshot({ path: '/tmp/' + filename });

        await new Promise(function (resolve, reject) {
            fs.readFile('/tmp/' + filename, (err, data) => {
                if (err) LOG.error(err);

                var base64data = Buffer.from(data);

                var params = {
                    Bucket: process.env.DEBUG_BUCKET,
                    Key: filename,
                    Body: base64data
                };

                s3.upload(params, (err, data) => {
                    if (err) LOG.error(`Upload Error ${err}`);
                    LOG.debug('Debug screenshot upload completed - ' + filename);
                    resolve();
                });
            });
        });
    }
};

async function login(page) {
    let secretdata = {};
    await secretsmanager.getSecretValue({
        SecretId: process.env.SECRET_ARN
    }, function (err, data) {
        if (err) {
            LOG.error(err, err.stack);
            reject();
        }

        secretdata = JSON.parse(data.SecretString);
    }).promise();

    var passwordstr = secretdata.password;

    await page.goto('https://' + process.env.ACCOUNTID + '.signin.aws.amazon.com/console', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await debugScreenshot(page);

    await page.waitFor(2000);

    let username = await page.$('#username');
    await username.press('Backspace');
    await username.type(secretdata.username, { delay: 100 });

    let password = await page.$('#password');
    await password.press('Backspace');
    await password.type(passwordstr, { delay: 100 });

    await page.click('#signin_button');

    await debugScreenshot(page);

    await page.waitFor(5000);
}

async function createssoapp(page, properties) {
    await page.goto('https://console.aws.amazon.com/singlesignon/home?region=' + process.env.AWS_REGION + '#/applications/add', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.click('.add-custom-application-text');

    await page.waitFor(5000);

    await debugScreenshot(page);

    let signinurlel = await page.$('awsui-control-group[label="AWS SSO sign-in URL"] > div > div > div > span > div > input');
    properties['SignInURL'] = await page.evaluate((obj) => {
        return obj.value;
    }, signinurlel);

    LOG.debug("Signin URL: " + properties['SignInURL']);

    let signouturlel = await page.$('awsui-control-group[label="AWS SSO sign-out URL"] > div > div > div > span > div > input');
    properties['SignOutURL'] = await page.evaluate((obj) => {
        return obj.value;
    }, signouturlel);

    LOG.debug("Signout URL: " + properties['SignOutURL']);

    await page._client.send('Page.setDownloadBehavior', {behavior: 'allow', downloadPath: '/tmp/'});
    await page.click('awsui-button[click="peregrineMetadata.downloadCertificate()"] > button');

    let appdisplayname = await page.$('awsui-textfield[ng-model="configureApplication.displayName"] > input');
    await page.evaluate((obj) => {
        return obj.value = "";
    }, appdisplayname);
    await appdisplayname.press('Backspace');
    await appdisplayname.type(properties.SSOManagerAppName, { delay: 100 });

    let appdescription = await page.$('awsui-textarea[ng-model="configureApplication.description"] > textarea');
    await page.evaluate((obj) => {
        return obj.value = "";
    }, appdescription);
    await appdescription.press('Backspace');
    await appdescription.type("AWS Accounts Manager", { delay: 100 });

    await page.click('awsui-button[click="configureApplication.toggleServiceProviderConfiguration()"]'); // manual metadata values

    await page.waitFor(200);

    let acsurl = await page.$('awsui-textfield[ng-model="configureApplication.loginURL"] > input');
    await acsurl.press('Backspace');
    await acsurl.type(properties['APIGatewayEndpoint'] + "/saml", { delay: 100 });
    
    let samlaudience = await page.$('awsui-textfield[ng-model="configureApplication.samlAudience"] > input');
    await samlaudience.press('Backspace');
    await samlaudience.type("https://" + process.env.DOMAIN_NAME + "/metadata.xml", { delay: 100 });

    await debugScreenshot(page);

    await page.click('awsui-button[click="configureApplication.saveChanges()"]'); // save
    
    await page.waitFor(5000);

    fs.readdirSync('/tmp/').forEach(file => {
        if (file.endsWith("certificate.pem")) {
            properties['Certificate'] = fs.readFileSync('/tmp/' + file, 'utf8');
            fs.unlinkSync('/tmp/' + file);
        }
    });

    await debugScreenshot(page);

    await new Promise((resolve, reject) => {
        ssm.putParameter({
            Name: process.env.SSO_SSM_PARAMETER,
            Type: "String",
            Value: JSON.stringify(properties),
            Overwrite: true
        }, function (err, data) {
            if (err) {
                LOG.error(err, err.stack);
                reject();
            }
            resolve();
        });
    });

    // map attributes

    await debugScreenshot(page);

    let paneltabs = await page.$$('.awsui-tabs-container > li');
    await paneltabs[1].click();

    await page.waitFor(500);

    await debugScreenshot(page);

    await page.click('awsui-select[ng-model="item.schemaProperty.nameIdFormat"]');
    await page.waitFor(200);
    await page.click('li[data-value="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"]');

    let attrmappings = {
        'Subject': '${user:AD_GUID}', // required
        'name': '${user:name}',
        'guid': '${user:AD_GUID}',
        'email': '${user:email}'
    }

    for (const attr in attrmappings) {
        if (attr != "Subject") {
            await page.click('.add-attribute');

            let samlattrnames = await page.$$('awsui-textfield[ng-model="item.key"] > input');
            let samlattrname = samlattrnames.pop();
            await samlattrname.press('Backspace');
            await samlattrname.type(attr, { delay: 100 });
        }

        let samlattrvals = await page.$$('awsui-textfield[ng-model="item.property.source[0]"] > input'); // .ng-invalid-saml-attribute > input
        let samlattrval = samlattrvals.pop();
        await samlattrval.press('Backspace');
        await samlattrval.type(attrmappings[attr], { delay: 100 });

        await page.waitFor(200);
    }

    await debugScreenshot(page);

    await page.click('awsui-button[click="samlSection.saveChanges()"]'); // Save changes

    await page.waitFor(5000);

    await debugScreenshot(page);

    return properties;
}

async function deletessoapp(page, properties) {
    await page.goto('https://console.aws.amazon.com/singlesignon/home?region=' + process.env.AWS_REGION + '#/applications', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    let apptooltip = await page.$$('truncate[tooltip="' + properties.SSOManagerAppName + '"]');
    if (apptooltip.length == 1) {
        await page.evaluate((obj) => {
            return obj.parentNode.parentNode.parentNode.firstElementChild.click();
        }, apptooltip[0]);
        await page.waitFor(200);

        await page.click('awsui-button-dropdown[text="Actions"]');
        await page.waitFor(200);

        let dropdownitems = await page.$$('.awsui-button-dropdown-item-content');
        await dropdownitems.forEach(async (item) => {
            await page.evaluate((obj) => {
                if (obj.innerText.trim() == "Remove") {
                    obj.click();
                }
            }, item);
        });
        await page.waitFor(1000);

        await page.click('.modal-confirm');
        await page.waitFor(6000);

        await debugScreenshot(page);
    } else {
        LOG.warn("Multiple SSO applications of the same name found, skipping");
    }
}

async function createinstance(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/onboarding', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    let directory = await page.$('input[ng-model="ad.directoryAlias"]');
    await directory.press('Backspace');
    await directory.type(properties.Domain, { delay: 100 });

    page.focus('button.awsui-button-variant-primary');
    await page.click('button.awsui-button-variant-primary');

    await page.waitForSelector('label.vertical-padding.option-label');
    await page.waitFor(200);
    let skipradio = await page.$$('label.vertical-padding.option-label');
    skipradio.pop().click();

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitFor(200);

    await page.click('button[type="submit"].awsui-button-variant-primary');

    await page.waitForSelector('.onboarding-success-message', {timeout: 180000});

    await debugScreenshot(page);

    await page.waitFor(3000);
}

async function open(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(8000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    await page.click('table > tbody > tr > td:nth-child(1) > div > a');

    await page.waitFor(5000);

    let loginbutton = await page.$('a[ng-show="org.organizationId"]');
    let loginlink = await page.evaluate((obj) => {
        return obj.getAttribute('href');
    }, loginbutton);

    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com' + loginlink, {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.waitFor(8000);

    await debugScreenshot(page);
}

async function deleteinstance(page, properties) {
    await page.goto('https://' + process.env.AWS_REGION + '.console.aws.amazon.com/connect/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(8000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    let checkbox = await page.$$('awsui-checkbox > label > input');
    await checkbox[0].click();
    await page.waitFor(200);

    await debugScreenshot(page);
    LOG.debug("Clicked checkbox");

    let removebutton = await page.$$('button[type="submit"]');
    LOG.debug(removebutton.length);
    await removebutton[1].click();
    LOG.debug("Clicked remove");
    await page.waitFor(200);

    let directory = await page.$('.awsui-textfield-type-text');
    await directory.press('Backspace');
    await directory.type(properties.Domain, { delay: 100 });
    await page.waitFor(200);

    await page.click('awsui-button[click="confirmDeleteOrg()"] > button');
    await page.waitFor(5000);

    await debugScreenshot(page);
}

async function claimnumber(page, properties) {
    let host = 'https://' + new url.URL(await page.url()).host;

    LOG.debug(host + '/connect/numbers/claim');

    await page.goto(host + '/connect/numbers/claim', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.waitFor(3000);

    await page.click('li[heading="DID (Direct Inward Dialing)"] > a');

    await page.waitFor(200);

    await page.click('div.active > span > div.country-code-real-input');

    await page.waitFor(200);

    await page.click('div.active > span.country-code-input.ng-scope > ul > li > .us-flag'); // USA

    await page.waitFor(5000);

    await page.click('div.active > awsui-radio-group > div > span > div:nth-child(1) > awsui-radio-button > label.awsui-radio-button-wrapper-label > div'); // Phone number selection

    let phonenumber = await page.$('div.active > awsui-radio-group > div > span > div:nth-child(1) > awsui-radio-button > label.awsui-radio-button-checked.awsui-radio-button-label > div > span > div');
    let phonenumbertext = await page.evaluate(el => el.textContent, phonenumber);

    await page.waitFor(200);

    await debugScreenshot(page);

    let disclaimerlink = await page.$('div.tab-pane.ng-scope.active > div.alert.alert-warning.ng-scope > a');
    if (disclaimerlink !== null) {
        disclaimerlink.click();
    }

    await page.waitFor(200);

    await debugScreenshot(page);

    await page.click('#s2id_select-width > a');
    
    await page.waitFor(2000);

    await debugScreenshot(page);

    let s2input = await page.$('#select2-drop > div > input');
    await s2input.press('Backspace');
    await s2input.type("myFlow", { delay: 100 });
    await page.waitFor(2000);
    await s2input.press('Enter');
    await page.waitFor(1000);

    await debugScreenshot(page);

    await page.click('awsui-button[text="Save"] > button');
    await page.waitFor(5000);

    await debugScreenshot(page);

    return {
        'PhoneNumber': phonenumbertext
    };
}

async function uploadprompts(page, properties) {
    let host = 'https://' + new url.URL(await page.url()).host;

    let ret = {};
    
    let prompt_filenames = [
        'a-10-second-silence.wav',
        '9.wav',
        '8.wav',
        '7.wav',
        '6.wav',
        '5.wav',
        '4.wav',
        '3.wav',
        '2.wav',
        '1.wav',
        '0.wav'
    ];
    
    for (var pid in prompt_filenames) {
        let filename = prompt_filenames[pid];

        do {
            await page.goto(host + "/connect/prompts/create", {
                timeout: 0,
                waitUntil: ['domcontentloaded']
            });
            await page.waitFor(5000);
            LOG.info("Checking for correct load");
            LOG.debug(host + "/connect/prompts/create");
        } while (await page.$('#uploadFileBox') === null);

        await debugScreenshot(page);

        const fileInput = await page.$('#uploadFileBox');
        await fileInput.uploadFile(process.env.LAMBDA_TASK_ROOT + '/prompts/' + filename);

        await page.waitFor(1000);

        let input1 = await page.$('#name');
        await input1.press('Backspace');
        await input1.type(filename, { delay: 100 });

        await debugScreenshot(page);

        await page.waitFor(1000);

        await page.click('#lily-save-resource-button');

        await page.waitFor(8000);

        await debugScreenshot(page);
        
        await page.$('#collapsePrompt0 > div > div:nth-child(2) > table > tbody > tr > td');
        let promptid = await page.$eval('#collapsePrompt0 > div > div:nth-child(2) > table > tbody > tr > td', el => el.textContent);
        LOG.debug("PROMPT ID:");
        LOG.debug(promptid);
        ret[filename] = promptid;
    };

    await debugScreenshot(page);

    return ret;
}

async function createflow(page, properties, prompts) {
    let host = 'https://' + new url.URL(await page.url()).host;
    
    do {
        await page.goto(host + "/connect/contact-flows/create?type=contactFlow", {
            timeout: 0,
            waitUntil: ['domcontentloaded']
        });
        await page.waitFor(5000);
        LOG.info("Checking for correct load");
        LOG.debug(host + "/connect/contact-flows/create?type=contactFlow");
    } while (await page.$('#angularContainer') === null);

    await debugScreenshot(page);

    await page.click('#can-edit-contact-flow > div > awsui-button > button');

    await page.waitFor(200);

    await debugScreenshot(page);

    await page.click('li[ng-if="cfImportExport"]');

    await page.waitFor(500);

    await page.setBypassCSP(true);

    await debugScreenshot(page);

    let flow = `{
    "modules": [
        {
            "id": "a238d7ff-9df4-481b-bcf5-e472c3a51abf",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "39ca9b44-c416-45eb-b2c0-591956bd2fe9"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt2",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 700,
                    "y": 16
                },
                "useDynamic": true
            }
        },
        {
            "id": "1f4d3616-77cc-4cef-8881-949c531e13ce",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "a238d7ff-9df4-481b-bcf5-e472c3a51abf"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt1",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 456,
                    "y": 19
                },
                "useDynamic": true
            }
        },
        {
            "id": "ad3b6726-dfed-40fe-b4c7-95a9751fc4a7",
            "type": "InvokeExternalResource",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "1f4d3616-77cc-4cef-8881-949c531e13ce"
                },
                {
                    "condition": "Error",
                    "transition": "f5205242-eeb0-4b71-bb47-f8c2adf848fa"
                }
            ],
            "parameters": [
                {
                    "name": "FunctionArn",
                    "value": "arn:aws:lambda:us-east-1:${ACCOUNTID}:function:AccountAutomator",
                    "namespace": null
                },
                {
                    "name": "TimeLimit",
                    "value": "8"
                }
            ],
            "metadata": {
                "position": {
                    "x": 191,
                    "y": 15
                },
                "dynamicMetadata": {},
                "useDynamic": false
            },
            "target": "Lambda"
        },
        {
            "id": "39ca9b44-c416-45eb-b2c0-591956bd2fe9",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "406812d0-65de-4f5a-ba33-89c450b94238"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt3",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 948,
                    "y": 18
                },
                "useDynamic": true
            }
        },
        {
            "id": "f5205242-eeb0-4b71-bb47-f8c2adf848fa",
            "type": "Disconnect",
            "branches": [],
            "parameters": [],
            "metadata": {
                "position": {
                    "x": 1442,
                    "y": 22
                }
            }
        },
        {
            "id": "406812d0-65de-4f5a-ba33-89c450b94238",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "2298a0bd-cb66-4476-b1cb-1680a079eca6"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "prompt4",
                    "namespace": "External",
                    "resourceName": null
                }
            ],
            "metadata": {
                "position": {
                    "x": 1198,
                    "y": 17
                },
                "useDynamic": true
            }
        },
        {
            "id": "2298a0bd-cb66-4476-b1cb-1680a079eca6",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "f5205242-eeb0-4b71-bb47-f8c2adf848fa"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "${prompts['a-10-second-silence.wav']}",
                    "namespace": null,
                    "resourceName": "a-10-second-silence.wav"
                }
            ],
            "metadata": {
                "position": {
                    "x": 1395,
                    "y": 268
                },
                "useDynamic": false,
                "promptName": "a-10-second-silence.wav"
            }
        },
        {
            "id": "e30d63b7-e7d5-42df-9dea-f93e0bed321d",
            "type": "PlayPrompt",
            "branches": [
                {
                    "condition": "Success",
                    "transition": "ad3b6726-dfed-40fe-b4c7-95a9751fc4a7"
                }
            ],
            "parameters": [
                {
                    "name": "AudioPrompt",
                    "value": "${prompts['a-10-second-silence.wav']}",
                    "namespace": null,
                    "resourceName": "a-10-second-silence.wav"
                }
            ],
            "metadata": {
                "position": {
                    "x": 120,
                    "y": 242
                },
                "useDynamic": false,
                "promptName": "a-10-second-silence.wav"
            }
        }
    ],
    "version": "1",
    "type": "contactFlow",
    "start": "e30d63b7-e7d5-42df-9dea-f93e0bed321d",
    "metadata": {
        "entryPointPosition": {
            "x": 24,
            "y": 17
        },
        "snapToGrid": false,
        "name": "myFlow",
        "description": "An example flow",
        "type": "contactFlow",
        "status": "published",
        "hash": "f8c17f9cd5523dc9c62111e55d2c225e0ee90ad8d509d677429cf6f7f2497a2f"
    }
}`;

    /*fs.writeFileSync("/tmp/flow.json", flow, {
        mode: 0o777
    });*/

    LOG.debug(flow);

    await page.waitFor(5000);

    page.click('#import-cf-file-button');
    let fileinput = await page.$('#import-cf-file');
    LOG.debug(fileinput);
    await page.waitFor(1000);
    await debugScreenshot(page);
    //await fileinput.uploadFile('/tmp/flow.json'); // broken!

    await page.evaluate((flow) => {
        angular.element(document.getElementById('import-cf-file')).scope().importContactFlow(new Blob([flow], {type: "application/json"}));
    }, flow);
    
    await page.waitFor(5000);

    await debugScreenshot(page);

    await page.click('.header-button'); // Publish
    await page.waitFor(2000);

    await page.click('awsui-button[text="Publish"] > button'); // Publish modal

    await page.waitFor(8000);

    await debugScreenshot(page);
}

async function loginStage1(page, email) {
    await page.goto('https://console.aws.amazon.com/console/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitForSelector('#resolving_input', {timeout: 15000});
    await page.waitFor(500);

    LOG.debug("Entering email " + email);
    let resolvinginput = await page.$('#resolving_input');
    await resolvinginput.press('Backspace');
    await resolvinginput.type(email, { delay: 100 });

    await page.click('#next_button');

    await debugScreenshot(page);

    await page.waitFor(5000);

    let captchacontainer = await page.$('#captcha_container');
    let captchacontainerstyle = await page.evaluate((obj) => {
        return obj.getAttribute('style');
    }, captchacontainer);

    var captchanotdone = true;
    var captchaattempts = 0;

    if (captchacontainerstyle.includes("display: none")) {
        LOG.debug("Skipping login CAPTCHA");
    } else {
        while (captchanotdone) {
            captchaattempts += 1;
            if (captchaattempts > 6) {
                LOG.error("Failed CAPTCHA too many times, aborting");
                return;
            }
            try {
                let submitc = await page.$('#submit_captcha');

                await debugScreenshot(page);
                let recaptchaimgx = await page.$('#captcha_image');
                let recaptchaurlx = await page.evaluate((obj) => {
                    return obj.getAttribute('src');
                }, recaptchaimgx);

                LOG.debug("CAPTCHA IMG URL:");
                LOG.debug(recaptchaurlx);
                let result = await solveCaptcha(page, recaptchaurlx);

                LOG.debug("CAPTCHA RESULT:");
                LOG.debug(result);

                let input3 = await page.$('#captchaGuess');
                await input3.press('Backspace');
                await input3.type(result, { delay: 100 });

                await debugScreenshot(page);
                await submitc.click();
                await page.waitFor(5000);

                await debugScreenshot(page);

                captchacontainer = await page.$('#captcha_container');
                captchacontainerstyle = await page.evaluate((obj) => {
                    return obj.getAttribute('style');
                }, captchacontainer);

                if (captchacontainerstyle.includes("display: none")) {
                    LOG.debug("Successful CAPTCHA solve");

                    captchanotdone = false;
                }
            } catch (error) {
                LOG.error(error);
            }
        }

        await page.waitFor(5000);
    }
}

async function handleEmailInbound(page, event) {
    for (const record of event['Records']) {
        var account = null;
        var email = '';
        var body = '';
        var isdeletable = false;
        
        await s3.getObject({
            Bucket: record.s3.bucket.name,
            Key: record.s3.object.key
        }).promise().then(async (data) => {
            await new Promise(async (resolve, reject) => {
                LOG.debug("Started processing e-mail");

                var msg = InternetMessage.parse(data.Body.toString());

                email = msg.to;
                body = msg.body;

                var emailmatches = /<(.*)>/g.exec(msg.to);
                if (emailmatches && emailmatches.length > 1) {
                    email = emailmatches[1];
                }

                await new Promise(async (resolve, reject) => {
                    organizations.listAccounts({
                        // no params
                    }, async function (err, data) {
                        if (err) {
                            LOG.error(err);
                        }
    
                        accounts = data.Accounts;
                        while (data.NextToken) {
                            await new Promise(async (xresolve, reject) => {
                                organizations.listAccounts({
                                    x: data.NextToken
                                }, async function (err, xdata) {
                                    accounts = accounts.concat(xdata.Accounts);
                                    data = xdata;
                                    xresolve();
                                });
                            });
                        }
        
                        accounts.forEach(accountitem => {
                            if (accountitem.Email == email) {
                                account = accountitem;
                            }
                        });
    
                        LOG.debug(account);
        
                        resolve();
                    });
                });

                var accountemailforwardingaddress = null;

                if (account) {
                    await new Promise(async (resolve, reject) => {
                        organizations.listTagsForResource({ // TODO: paginate
                            ResourceId: account.Id
                        }, async function (err, data) {
                            data.Tags.forEach(tag => {
                                if (tag.Key.toLowerCase() == "delete" && tag.Value.toLowerCase() == "true") {
                                    isdeletable = true;
                                }
                                if (tag.Key.toLowerCase() == "accountemailforwardingaddress") {
                                    accountemailforwardingaddress = tag.Value;
                                }
                            });
                            resolve();
                        });
                    });
                }
                
                var accountid = "?";
                var accountemail = "?";
                var accountname= "?";
                if (account) {
                    accountid = account.Id || "?";
                    accountemail = account.Email || "?";
                    accountname = account.Name || "?";
                }
                var msgsubject = msg.subject || "";
                var from = msg.from || "";
                var to = msg.to || "";

                msg.subject = process.env.EMAIL_SUBJECT.
                    replace("{subject}", msgsubject).
                    replace("{from}", from).
                    replace("{to}", to).
                    replace("{accountid}", accountid).
                    replace("{accountname}", accountname).
                    replace("{accountemail}", accountemail);

                msg.to = accountemailforwardingaddress || "AWS Accounts Master <" + MASTER_EMAIL + ">";
                msg.from = "AWS Accounts Master <" + MASTER_EMAIL + ">";
                msg['return-path'] = "AWS Accounts Master <" + MASTER_EMAIL + ">";

                var stringified = InternetMessage.stringify(msg);
                
                ses.sendRawEmail({
                    Source: MASTER_EMAIL,
                    Destinations: [msg.to],
                    RawMessage: {
                        Data: stringified
                    }
                }, function (err, data) {
                    if (err) {
                        LOG.debug(err);

                        msg.to = "AWS Accounts Master <" + MASTER_EMAIL + ">";
                        
                        ses.sendRawEmail({
                            Source: MASTER_EMAIL,
                            Destinations: [MASTER_EMAIL],
                            RawMessage: {
                                Data: "To: " + msg.to + "\r\nFrom: " + msg.from + "\r\nSubject: " + msg.subject + "\r\n\r\n***CONTENT NOT PROCESSABLE***\r\n\r\nDownload the email from s3://" + record.s3.bucket.name + "/" + record.s3.object.key + "\r\n"
                            }
                        }, function (err, data) {
                            LOG.debug(err);

                            resolve();
                        });
                    } else {
                        resolve();
                    }
                });
            });

            if (!account) {
                LOG.debug("No account found, aborting");
                return;
            }

            LOG.debug(body);

            let filteredbody = body.replace(/=3D/g, '=').replace(/=\r\n/g, '');

            let start = filteredbody.indexOf("https://signin.aws.amazon.com/resetpassword");
            if (start !== -1) {
                LOG.debug("Started processing password reset");

                let secretdata = {};
                await secretsmanager.getSecretValue({
                    SecretId: process.env.SECRET_ARN
                }, function (err, data) {
                    if (err) {
                        LOG.error(err, err.stack);
                        reject();
                    }
        
                    secretdata = JSON.parse(data.SecretString);
                }).promise();

                let end = filteredbody.indexOf("<", start);
                let url = filteredbody.substring(start, end);

                let parsedurl = new URL(url);
                if (parsedurl.host != "signin.aws.amazon.com") {
                    throw "Unexpected reset password host";
                }

                LOG.debug(url);
                
                await page.goto(url, {
                    timeout: 0,
                    waitUntil: ['domcontentloaded']
                });
                await page.waitFor(5000);

                await debugScreenshot(page);

                let newpwinput = await page.$('#new_password');
                await newpwinput.press('Backspace');
                await newpwinput.type(secretdata.password, { delay: 100 });

                let input2 = await page.$('#confirm_password');
                await input2.press('Backspace');
                await input2.type(secretdata.password, { delay: 100 });

                await page.click('#reset_password_submit');
                await page.waitFor(5000);

                LOG.info("Completed resetpassword link verification");

                if (isdeletable) {
                    LOG.info("Begun delete account");

                    await loginStage1(page, email);

                    await debugScreenshot(page);
                    
                    let input4 = await page.$('#password');
                    await input4.press('Backspace');
                    await input4.type(secretdata.password, { delay: 100 });

                    await debugScreenshot(page);

                    await page.click('#signin_button');
                    await page.waitFor(8000);
                    
                    await debugScreenshot(page);

                    await page.goto('https://portal.aws.amazon.com/billing/signup?client=organizations&enforcePI=True', {
                        timeout: 0,
                        waitUntil: ['domcontentloaded']
                    });
                    await page.waitFor(8000);
                    
                    await debugScreenshot(page);
                    LOG.debug("Screenshotted at portal");
                    LOG.debug(page.mainFrame().url());
                    // /confirmation is an activation period
                    if (page.mainFrame().url().split("#").pop() == "/paymentinformation") {

                        let input5 = await page.$('#credit-card-number');
                        await input5.press('Backspace');
                        await input5.type(secretdata.ccnumber, { delay: 100 });

                        await page.select('#expirationMonth', (parseInt(secretdata.ccmonth)-1).toString());

                        await page.waitFor(2000);
                        await debugScreenshot(page);

                        let currentyear = new Date().getFullYear();

                        await page.select('select[name=\'expirationYear\']', (parseInt(secretdata.ccyear)-currentyear).toString());

                        let input6 = await page.$('#accountHolderName');
                        await input6.press('Backspace');
                        await input6.type(secretdata.ccname, { delay: 100 });

                        await page.waitFor(2000);
                        await debugScreenshot(page);

                        await page.click('.form-submit-click-box > button');

                        await page.waitFor(8000);
                    }

                    await debugScreenshot(page);

                    if (page.mainFrame().url().split("#").pop() == "/identityverification") {
                        let usoption = await page.$('option[label="United States (+1)"]');
                        let usvalue = await page.evaluate( (obj) => {
                            return obj.getAttribute('value');
                        }, usoption);

                        await page.select('#countryCode', usvalue);

                        let portalphonenumber = await page.$('#phoneNumber');
                        await portalphonenumber.press('Backspace');
                        await portalphonenumber.type(process.env.PHONE_NUMBER.replace("+1", ""), { delay: 100 });

                        var captchanotdone = true;
                        while (captchanotdone) {
                            try {
                                let submitc = await page.$('#btnCall');

                                await debugScreenshot(page);
                                let recaptchaimgx = await page.$('#imageCaptcha');
                                let recaptchaurlx = await page.evaluate((obj) => {
                                    return obj.getAttribute('src');
                                }, recaptchaimgx);

                                LOG.debug("CAPTCHA IMG URL:");
                                LOG.debug(recaptchaurlx);
                                let result = await solveCaptcha(page, recaptchaurlx);

                                LOG.debug("CAPTCHA RESULT:");
                                LOG.debug(result);

                                let input32 = await page.$('#guess');
                                await input32.press('Backspace');
                                await input32.type(result, { delay: 100 });

                                await debugScreenshot(page);
                                await submitc.click();
                                await page.waitFor(5000);

                                await debugScreenshot(page);

                                await page.waitForSelector('.phone-pin-number', {timeout: 5000});
                                
                                captchanotdone = false;
                            } catch (error) {
                                LOG.error(error);
                            }
                        }

                        let phonecode = await page.$('.phone-pin-number > span');
                        let phonecodetext = await page.evaluate(el => el.textContent, phonecode);

                        await debugScreenshot(page);
                        
                        await new Promise((resolve, reject) => {
                            ssm.getParameter({
                                Name: process.env.CONNECT_SSM_PARAMETER
                            }, function (err, data) {
                                if (err) {
                                    LOG.error(err, err.stack);
                                    reject();
                                } else {
                                    let variables = JSON.parse(data['Parameter']['Value']);
                                    
                                    variables['CODE'] = phonecodetext;
                    
                                    ssm.putParameter({
                                        Name: process.env.CONNECT_SSM_PARAMETER,
                                        Type: "String",
                                        Value: JSON.stringify(variables),
                                        Overwrite: true
                                    }, function (err, data) {
                                        if (err) {
                                            LOG.error(err, err.stack);
                                            reject();
                                        }
                                        resolve();
                                    });
                                }
                            });
                        });

                        await page.waitFor(20000);
                        
                        await debugScreenshot(page);

                        await page.click('#verification-complete-button');

                        await page.waitFor(3000);
                        
                        await debugScreenshot(page);

                    }

                    if (page.mainFrame().url().split("#").pop() == "/support" || page.mainFrame().url().split("#").pop() == "/confirmation") {
                        await page.goto('https://console.aws.amazon.com/billing/rest/v1.0/account', {
                            timeout: 0,
                            waitUntil: ['domcontentloaded']
                        });

                        await page.waitFor(3000);

                        await debugScreenshot(page);

                        let accountstatuspage = await page.content();

                        LOG.debug(accountstatuspage);

                        let issuspended = accountstatuspage.includes("\"accountStatus\":\"Suspended\"");

                        if (!issuspended) {
                            await page.goto('https://console.aws.amazon.com/billing/home?#/account', {
                                timeout: 0,
                                waitUntil: ['domcontentloaded']
                            });

                            await page.waitFor(8000);

                            await debugScreenshot(page);

                            let closeaccountcbs = await page.$$('.close-account-checkbox > input');
                            await closeaccountcbs.forEach(async (cb) => {
                                await cb.click();
                            });

                            await page.waitFor(1000);

                            await debugScreenshot(page);

                            await page.click('.btn-danger'); // close account button

                            await page.waitFor(1000);

                            await debugScreenshot(page);

                            await page.click('.modal-footer > button.btn-danger'); // confirm close account button

                            await page.waitFor(5000);

                            await debugScreenshot(page);

                            await organizations.tagResource({
                                ResourceId: account.Id,
                                Tags: [{
                                    Key: "AccountDeletionTime",
                                    Value: (new Date()).toISOString()
                                }]
                            }).promise();
                        }

                        await removeAccountFromOrg(account);
                    } else {
                        LOG.warn("Unsure of location, send help! - " + page.mainFrame().url());
                    }
                }
                
            } else {
                LOG.debug("No password reset found");
            }
        });
    }
    
    return true;
};

async function removeAccountFromOrg(account) {
    var now = new Date();
    var threshold = new Date(account.JoinedTimestamp);
    threshold.setDate(threshold.getDate() + 7); // 7 days
    if (now > threshold) {
        await organizations.removeAccountFromOrganization({
            AccountId: account.Id
        }, function(err, data) {
            LOG.info("Removed account from Org");
        });

        return true;
    } else {
        threshold.setMinutes(threshold.getMinutes() + 2); // plus 2 minutes buffer
        await eventbridge.putRule({
            Name: "ScheduledAccountDeletion-" + account.Id.toString(),
            Description: "The scheduled deletion of an Organizations account",
            //RoleArn: '',
            ScheduleExpression: "cron(" + threshold.getMinutes() + " " + threshold.getUTCHours() + " " + threshold.getUTCDate() + " " + (threshold.getUTCMonth() + 1) + " ? " + threshold.getUTCFullYear() + ")",
            State: "ENABLED"
        }).promise();

        await eventbridge.putTargets({
            Rule: "ScheduledAccountDeletion-" + account.Id.toString(),
            Targets: [{
                Arn: "arn:aws:lambda:" + process.env.AWS_REGION + ":" + process.env.ACCOUNTID  + ":function:" + process.env.AWS_LAMBDA_FUNCTION_NAME,
                Id: "Lambda",
                //RoleArn: "",
                Input: JSON.stringify({
                    "action": "removeAccountFromOrg",
                    "account": account,
                    "ruleName": "ScheduledAccountDeletion-" + account.Id.toString()
                })
            }]
        }).promise();

        await organizations.tagResource({
            ResourceId: account.Id,
            Tags: [{
                Key: "ScheduledRemovalTime",
                Value: threshold.toISOString()
            }]
        }).promise();

        LOG.info("Scheduled removal for later");
    }

    return false;
}

async function triggerReset(page, event) {
    await loginStage1(page, event.email);
    
    await debugScreenshot(page);

    await page.waitForSelector('#password_recovery_captcha_image', {timeout: 15000});

    captchanotdone = true;
    captchaattempts = 0;
    while (captchanotdone) {
        captchaattempts += 1;
        if (captchaattempts > 6) {
            LOG.error("Failed CAPTCHA too many times, aborting");
            return;
        }

        await debugScreenshot(page);

        let recaptchaimg = await page.$('#password_recovery_captcha_image');
        let recaptchaurl = await page.evaluate((obj) => {
            return obj.getAttribute('src');
        }, recaptchaimg);

        LOG.debug(recaptchaurl);
        let captcharesult = await solveCaptcha(page, recaptchaurl);

        let input2 = await page.$('#password_recovery_captcha_guess');
        await input2.press('Backspace');
        await input2.type(captcharesult, { delay: 100 });

        await page.waitFor(3000);

        await debugScreenshot(page);

        await page.click('#password_recovery_ok_button');

        await page.waitFor(5000);

        let errormessagediv = await page.$('#password_recovery_error_message');
        let errormessagedivstyle = await page.evaluate((obj) => {
            return obj.getAttribute('style');
        }, errormessagediv);
        
        if (errormessagedivstyle.includes("display: none")) {
            captchanotdone = false;
        }
    }

    await debugScreenshot(page);

    await page.waitFor(2000);
};

async function decodeSAMLResponse(sp, idp, samlresponse) {
    let resp = await new Promise((resolve,reject) => {
        sp.post_assert(idp, {
            request_body: {
                'SAMLResponse': samlresponse
            }
        }, function(err, resp) {
            if (err) {
                reject(err);
            } else {
                resolve(resp);
            }
        });
    });
    
    return resp;
}

function decodeForm(form) {
    var ret = {};

    var items = form.split("&");
    items.forEach(item => {
        var split = item.split("=");
        ret[split.shift()] = split.join("=");
    });

    return ret
}

async function handleSAMLRequest(event) {
    let ssoproperties = await new Promise((resolve, reject) => {
        ssm.getParameter({
            Name: process.env.SSO_SSM_PARAMETER
        }, function (err, data) {
            if (err) {
                LOG.error(err, err.stack);
                reject();
            } else {
                resolve(JSON.parse(data['Parameter']['Value']));
            }
        });
    });

    let body = event.body;
    if (event.isBase64Encoded) {
        body = Buffer.from(event.body, 'base64').toString('utf8');
    }

    var sp_options = {
        entity_id: "https://" + process.env.DOMAIN_NAME + "/metadata.xml",
        private_key: "",
        certificate: "",
        assert_endpoint: "",
        allow_unencrypted_assertion: true
    };
    var sp = new saml2.ServiceProvider(sp_options);
    
    var idp_options = {
        sso_login_url: ssoproperties['SignInURL'],
        sso_logout_url: ssoproperties['SignOutURL'],
        certificates: [ssoproperties['Certificate']],
        allow_unencrypted_assertion: true
    };
    var idp = new saml2.IdentityProvider(idp_options);

    var form = decodeForm(body);

    let samlattrs = await decodeSAMLResponse(sp, idp, decodeURIComponent(form['SAMLResponse']));

    let user = {
        'name': samlattrs['user']['attributes']['name'][0],
        'email': samlattrs['user']['attributes']['email'][0],
        'guid': samlattrs['user']['attributes']['guid'][0],
        'samlresponse': form['SAMLResponse']
    };

    var redirectURL = ssoproperties['APIGatewayEndpoint'];

    return {
        "statusCode": 200,
        "isBase64Encoded": false,
        "headers": {
            "Content-Type": "text/html"
        },
        "body": wrapHTML(ssoproperties, user)
    };
}

function wrapHTML(ssoprops, user) {
    return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
        <meta name="description" content="">
        <title>${ssoprops.SSOManagerAppName}</title>

        <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.4.1/css/bootstrap.min.css" integrity="sha384-Vkoo8x4CGsO3+Hhxv8T/Q5PaXtkKtu6ug5TOeNV6gBiFeWPGFN9MuhOf23Q9Ifjh" crossorigin="anonymous">
        <script src="https://kit.fontawesome.com/a9a4873efc.js" crossorigin="anonymous"></script>
      </head>
      <body class="bg-light">
        <div class="container">
        <div class="row">
        <div class="col-md-12">
        <p class="float-right mt-4 text-muted">${user.name} (${user.email})&nbsp;&nbsp;|&nbsp;&nbsp;<a href="${ssoprops.SignOutURL}">Back to SSO</a></p>
        </div>
        </div>
      
        <div class="py-5 text-center" style="padding-top: 1rem!important;">
        <svg class="d-block mx-auto mb-4" height="72" viewBox="0 0 64 64" width="72" xmlns="http://www.w3.org/2000/svg"><g id="AccMgrLogo" data-name="AccMgrLogo"><path d="m53.54 41.34a8.047 8.047 0 0 0 -4.54-4.76v-25.58h-44a2.006 2.006 0 0 0 -2 2v6h40v17.59c-.23.09-.46.2-.68.31a11.984 11.984 0 0 0 -22.15 4.14 10 10 0 0 0 .83 19.96h30a9.993 9.993 0 0 0 2.54-19.66z" fill="#bddbff"/><g fill="#57a4ff"><path d="m6 14h2v2h-2z"/><path d="m10 14h2v2h-2z"/><path d="m14 14h2v2h-2z"/><path d="m38 14h2v2h-2z"/><path d="m12 6h2v2h-2z"/><path d="m16 6h2v2h-2z"/><path d="m20 6h2v2h-2z"/><path d="m44 6h2v2h-2z"/><path d="m54.29 40.51a8.985 8.985 0 0 0 -4.29-4.55v-30.96a3.009 3.009 0 0 0 -3-3h-36a3.009 3.009 0 0 0 -3 3v5h-3a3.009 3.009 0 0 0 -3 3v30a3.009 3.009 0 0 0 3 3h6.23a10.874 10.874 0 0 0 -1.23 5 11.007 11.007 0 0 0 11 11h30a11 11 0 0 0 3.29-21.49zm-44.29-35.51a1 1 0 0 1 1-1h36a1 1 0 0 1 1 1v5h-38zm33.82 7h4.18v23.25a8.454 8.454 0 0 0 -4-.02v-22.23a3 3 0 0 0 -.18-1zm-39.82 1a1 1 0 0 1 1-1h36a1 1 0 0 1 1 1v5h-38zm1 31a1 1 0 0 1 -1-1v-23h38v14.75a12.956 12.956 0 0 0 -22.67 5.38 11.047 11.047 0 0 0 -6.78 3.87zm46 16h-30a9 9 0 0 1 -.74-17.96 1 1 0 0 0 .9-.84 10.982 10.982 0 0 1 20.3-3.79 1 1 0 0 0 1.32.38 6.846 6.846 0 0 1 3.22-.79 7 7 0 0 1 6.59 4.67.993.993 0 0 0 .69.63 9 9 0 0 1 -2.28 17.7z"/><path d="m52.776 44.239-.506 1.936a4.994 4.994 0 0 1 -1.27 9.825v2a6.994 6.994 0 0 0 1.776-13.761z"/><path d="m16 51a5.018 5.018 0 0 1 4.582-4.974l-.163-1.994a7 7 0 0 0 .581 13.968v-2a5.006 5.006 0 0 1 -5-5z"/><path d="m23 56h4v2h-4z"/></g></g></svg>
        <h2>${ssoprops.SSOManagerAppName}</h2>
        <p class="lead">Below you can manage the AWS accounts that you have access to.</p>
      </div>
    
      <div class="row">
        <div class="col-md-6 order-md-1 mb-6">
          <h4 class="d-flex justify-content-between align-items-center mb-3">
            <span>Your accounts</span>
            <span class="badge badge-secondary badge-pill">2</span>
          </h4>
          <ul class="list-group mb-3">
            <li class="list-group-item d-flex justify-content-between lh-condensed">
              <div>
                <h6 class="my-0">Example 12</h6>
                <small class="text-muted">Custom notes here</small>
              </div>
              <span><i class="fas fa-trash-alt text-danger"></i></span>
            </li>
            <li class="list-group-item d-flex justify-content-between lh-condensed">
              <div>
                <h6 class="my-0">Example 15&nbsp;&nbsp;<span class="badge badge-dark">SHARED</span></h6>
                <small class="text-muted">Created by Joe Bloggs</small>
              </div>
              <span class="text-muted">&nbsp;</span>
            </li>
          </ul>
        </div>
        <div class="col-md-1 order-md-2"></div>
        <div class="col-md-5 order-md-3">
          <h4 class="mb-3">Create account</h4>
          <form class="needs-validation" novalidate>
    
            <div class="mb-3">
                <label for="emailprefix">E-mail Prefix</label>
                <div class="input-group">
                    <input type="text" class="form-control" id="emailprefix" placeholder="some-identifier" required>
                    <div class="input-group-prepend">
                        <span class="input-group-text">@${process.env.DOMAIN_NAME}</span>
                    </div>
                    <div class="invalid-feedback" style="width: 100%;">
                    An e-mail prefix is required.
                    </div>
                </div>
            </div>
    
            <div class="mb-3">
                <label for="accountname">Account Name</label>
                <input type="text" class="form-control" id="accountname" placeholder="My Account" required>
                <div class="invalid-feedback">
                    An account name is required.
                </div>
            </div>
            
            <div class="mb-3">
                <label for="notes">Notes <span class="text-muted">(Optional)</span></label>
                <input type="text" class="form-control" id="notes">
            </div>
    
            <hr class="mb-4">

            <div class="custom-control custom-checkbox">
              <input type="checkbox" class="custom-control-input" id="shareaccount">
              <label class="custom-control-label" for="shareaccount">This account can be accessed by everyone in my organization</label>
            </div>

            <hr class="mb-4">

            <button class="btn btn-primary btn-lg btn-block" type="submit">Create Account</button>
          </form>
        </div>
      </div>
    
      <footer class="my-5 pt-5 text-muted text-center text-small">
        <p class="mb-1">For support, contact your administrator at <a href="mailto:${process.env.MASTER_EMAIL}">${process.env.MASTER_EMAIL}</a></p>
      </footer>
    </div>
    <script src="https://code.jquery.com/jquery-3.4.1.slim.min.js" integrity="sha384-J6qa4849blE2+poT4WnyKhv5vZF5SrPo0iEjwBvKU7imGFAV0wwj1yYfoRSJoZ+n" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.0/dist/umd/popper.min.js" integrity="sha384-Q6E9RHvbIyZFJoft+2mJbHaEWldlvI9IOYy5n3zV9zzTtmI3UksdQRVvoxMfooAo" crossorigin="anonymous"></script>
    <script src="https://stackpath.bootstrapcdn.com/bootstrap/4.4.1/js/bootstrap.min.js" integrity="sha384-wfSDF2E50Y2D1uUdj0O3uMBJnjuUD4Ih7YwaYd1iqfktj0Uod8GCExl3Og8ifwB6" crossorigin="anonymous"></script>
    </body>
    </html>
    `;
}

exports.handler = async (event, context) => {
    let result = null;
    let browser = null;

    LOG.debug(event);

    if (event.source && event.source == "aws.organizations" && event.detail.eventName == "TagResource") {
        isdeletable = false;
        event.detail.requestParameters.tags.forEach(tag => {
            if (tag.key.toLowerCase() == "delete" && tag.value.toLowerCase() == "true") {
                isdeletable = true;
            }
        });

        if (isdeletable) {
            await new Promise(async (resolve, reject) => {
                organizations.describeAccount({
                    AccountId: event.detail.requestParameters.resourceId
                }, async function (err, data) {
                    if (err) {
                        LOG.error(err);
                    }

                    browser = await puppeteer.launch({
                        args: chromium.args,
                        defaultViewport: chromium.defaultViewport,
                        executablePath: await chromium.executablePath,
                        headless: chromium.headless,
                    });
            
                    let page = await browser.newPage();
            
                    await triggerReset(page, {
                        'email': data.Account.Email
                    });

                    resolve();
                });
            });
        }
    } else if (event.email) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        await triggerReset(page, event);
    } else if (event.action == "removeAccountFromOrg") {
        let removed = await removeAccountFromOrg(event.account);

        if (removed) {
            await eventbridge.deleteRule({
                Name: event.ruleName
            }).promise();
        }
    } else if (event.Records) {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        await handleEmailInbound(page, event);
    } else if (event.Name && event.Name == "ContactFlowEvent") {
        return {
            "prompt1": process.env['PROMPT_' + process.env.CODE[0]],
            "prompt2": process.env['PROMPT_' + process.env.CODE[1]],
            "prompt3": process.env['PROMPT_' + process.env.CODE[2]],
            "prompt4": process.env['PROMPT_' + process.env.CODE[3]]
        }
    } else if (event.ResourceType == "Custom::ConnectSetup") {
        let domain = event.StackId.split("-").pop();

        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        try {
            await login(page);

            if (event.RequestType == "Create") {
                await ses.setActiveReceiptRuleSet({
                    RuleSetName: "account-controller"
                }).promise();

                await createinstance(page, {
                    'Domain': domain
                });
                await page.waitFor(5000);
                await open(page, {
                    'Domain': domain
                });
                let hostx = new url.URL(await page.url()).host;
                while (hostx.indexOf('awsapps') == -1) {
                    await page.waitFor(20000);
                    await open(page, {
                        'Domain': domain
                    });
                    hostx = new url.URL(await page.url()).host;
                }
                let prompts = await uploadprompts(page, {
                    'Domain': domain
                });
                await createflow(page, {
                    'Domain': domain
                }, prompts);
                let number = await claimnumber(page, {
                    'Domain': domain
                });
                LOG.info("Registered phone number: " + number);

                await new Promise((resolve, reject) => {
                    let variables = {};
    
                    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(num => {
                        variables['PROMPT_' + num] = prompts[num + '.wav'];
                    });
                    variables['PHONE_NUMBER'] = number['PhoneNumber'].replace(/[ -]/g, "")
    
                    ssm.putParameter({
                        Name: process.env.CONNECT_SSM_PARAMETER,
                        Type: "String",
                        Value: JSON.stringify(variables),
                        Overwrite: true
                    }, function (err, data) {
                        if (err) {
                            LOG.error(err, err.stack);
                            reject();
                        }
                        resolve();
                    });
                });
            } else if (event.RequestType == "Delete") {
                await ses.setActiveReceiptRuleSet({
                    RuleSetName: "default-rule-set"
                }).promise();

                await ses.deleteReceiptRuleSet({
                    RuleSetName: "account-controller"
                }).promise();

                await deleteinstance(page, {
                    'Domain': domain
                });
            }

            await sendcfnresponse(event, context, "SUCCESS", {
                'Domain': domain
            }, domain);
        } catch(error) {
            await sendcfnresponse(event, context, "FAILED", {});

            await debugScreenshot(page);

            throw error;
        }
    } else if (event.ResourceType == "Custom::SSOSetup") {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
        });

        let page = await browser.newPage();

        try {
            await login(page);

            if (event.RequestType == "Create") {
                await createssoapp(page, {
                    'SSOPortalAlias': event.ResourceProperties.SSOPortalAlias,
                    'SSOManagerAppName': event.ResourceProperties.SSOManagerAppName,
                    'APIGatewayEndpoint': event.ResourceProperties.APIGatewayEndpoint
                });
            } else if (event.RequestType == "Delete") {
                await deletessoapp(page, {
                    'SSOPortalAlias': event.ResourceProperties.SSOPortalAlias,
                    'SSOManagerAppName': event.ResourceProperties.SSOManagerAppName,
                    'APIGatewayEndpoint': event.ResourceProperties.APIGatewayEndpoint
                });
            }

            await sendcfnresponse(event, context, "SUCCESS", {
                'SSOPortalAlias': event.ResourceProperties.SSOPortalAlias,
                "SSOManagerAppName": event.ResourceProperties.SSOManagerAppName,
                'APIGatewayEndpoint': event.ResourceProperties.APIGatewayEndpoint
            }, "SSOManager");
        } catch(error) {
            await sendcfnresponse(event, context, "FAILED", {});

            await debugScreenshot(page);

            throw error;
        }
    } else if (event.routeKey == "POST /saml") {
        let resp = await handleSAMLRequest(event);

        return resp;
    } else {
        return context.succeed();
    }
};

