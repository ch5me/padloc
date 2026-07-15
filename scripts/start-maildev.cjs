const MailDev = require("maildev");

const web = Number(process.env.MAILDEV_WEB_PORT || process.env.PORT);
const smtp = Number(process.env.MAILDEV_SMTP_PORT || process.env.DEVMUX_PORT_SMTP);
if (!Number.isInteger(web) || !Number.isInteger(smtp)) {
    throw new Error("DevMux must provide PORT and DEVMUX_PORT_SMTP");
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
