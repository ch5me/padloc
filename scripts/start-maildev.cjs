const MailDev = require("maildev");

const web = Number(process.env.MAILDEV_WEB_PORT || process.env.PORT);
const smtp = Number(process.env.MAILDEV_SMTP_PORT);
if (!Number.isInteger(web) || !Number.isInteger(smtp)) {
    throw new Error("MAILDEV_WEB_PORT/PORT and MAILDEV_SMTP_PORT are required");
}

const maildev = MailDev({ ip: "0.0.0.0", web, smtp });
maildev.listen((error) => {
    if (!error) return;
    console.error(error);
    process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => maildev.close(() => process.exit(0)));
}
