const state = {
loanAmount: 100000,
loanTerm: "12 months"
};

const $ = id => document.getElementById(id);

function showScreen(id) {
document.querySelectorAll(".screen").forEach(screen => {
screen.classList.remove("active");
});

const screen = $(id);
if (screen) {
screen.classList.add("active");
window.scrollTo({ top: 0, behavior: "smooth" });
}
}

function toast(message) {
const el = $("toast");
el.textContent = message;
el.classList.add("show");

clearTimeout(window.toastTimer);
window.toastTimer = setTimeout(() => {
el.classList.remove("show");
}, 3500);
}

function formatMoney(value) {
return Number(value || 0).toLocaleString("en-US");
}

function updateCalculator() {
const amount = Number($("amount").value);
const months = Number($("term").value);

state.loanAmount = amount;
state.loanTerm = "${months} months";

$("amountDisplay").textContent = "USD ${formatMoney(amount)}";
$("termDisplay").textContent = "${months} months";

// Simple estimate for the calculator only.
const annualRate = 0.08;
const monthlyRate = annualRate / 12;

const payment =
monthlyRate === 0
? amount / months
: amount *
(monthlyRate * Math.pow(1 + monthlyRate, months)) /
(Math.pow(1 + monthlyRate, months) - 1);

$("payment").textContent = "USD ${formatMoney(Math.round(payment))}";
}

$("amount").addEventListener("input", updateCalculator);
$("term").addEventListener("input", updateCalculator);

function startApplication() {
$("formAmount").value = $("amount").value;

const months = $("term").value;
const options = Array.from($("loanTerm").options);

const matching = options.find(option => option.value === "${months} months");
if (matching) {
$("loanTerm").value = matching.value;
}

showScreen("step1");
}

function validateStep1() {
const loanType = $("loanType").value;
const amount = Number($("formAmount").value);
const term = $("loanTerm").value;
const purpose = $("purpose").value.trim();

if (!loanType) {
toast("Please select a loan type.");
return false;
}

if (!Number.isFinite(amount) || amount <= 0 || amount > 500000) {
toast("Please enter a valid loan amount.");
return false;
}

if (!term) {
toast("Please select a loan term.");
return false;
}

if (!purpose) {
toast("Please enter the purpose of your loan.");
return false;
}

return true;
}

function validateStep2() {
const firstName = $("firstName").value.trim();
const lastName = $("lastName").value.trim();
const email = $("email").value.trim();
const phone = $("phone").value.trim();

if (!firstName || !lastName) {
toast("Please enter your first and last name.");
return false;
}

if (!/^[^\s@]+@[^\s@]+.[^\s@]+$/.test(email)) {
toast("Please enter a valid email address.");
return false;
}

if (!/^(+263|263|0|7)\d+$/.test(phone.replace(/\s/g, ""))) {
toast("Please enter a valid Zimbabwe phone number.");
return false;
}

return true;
}

function nextStep(step) {
if (step === 2 && !validateStep1()) return;

if (step === 3) {
if (!validateStep2()) return;

updateSummary();

}

showScreen("step${step}");
}

function updateSummary() {
$("summaryType").textContent = $("loanType").value;
$("summaryAmount").textContent =
"USD ${formatMoney($("formAmount").value)}";
$("summaryTerm").textContent = $("loanTerm").value;
$("summaryApplicant").textContent =
"${$("firstName").value.trim()} ${$("lastName").value.trim()}";
}

function normalizePhone(phone) {
let value = String(phone || "").replace(/[\s()-]/g, "");

if (/^07\d{8}$/.test(value)) {
return "+263" + value.slice(1);
}

if (/^7\d{8}$/.test(value)) {
return "+263" + value;
}

if (/^+2637\d{8}$/.test(value)) {
return value;
}

if (/^2637\d{8}$/.test(value)) {
return "+" + value;
}

return null;
}

async function submitApplication() {
if (!validateStep1() || !validateStep2()) {
return;
}

const employmentStatus = $("employmentStatus").value;
const annualIncome = Number($("annualIncome").value);

if (!employmentStatus) {
toast("Please select your employment status.");
return;
}

if (!Number.isFinite(annualIncome) || annualIncome <= 0) {
toast("Please enter your annual income.");
return;
}

const phone = normalizePhone($("phone").value);

if (!phone) {
toast("Please enter a valid Zimbabwe phone number.");
return;
}

const button = $("submitBtn");
button.disabled = true;
button.textContent = "SUBMITTING...";

const payload = {
loanType: $("loanType").value,
loanAmount: Number($("formAmount").value),
loanTerm: $("loanTerm").value,
purpose: $("purpose").value.trim(),
firstName: $("firstName").value.trim(),
lastName: $("lastName").value.trim(),
email: $("email").value.trim(),
phone,
employmentStatus,
annualIncome
};

try {
const response = await fetch("/api/applications", {
method: "POST",
headers: {
"Content-Type": "application/json"
},
body: JSON.stringify(payload)
});

const data = await response.json().catch(() => ({}));

/*
  The backend may return 503 when an external SMS verification
  provider is not configured. We display the actual server message
  instead of falsely claiming the application was submitted.
*/
if (!response.ok) {
  throw new Error(
    data.error || "Could not submit the application."
  );
}

localStorage.setItem(
  "lastApplicationId",
  data.id || ""
);

showScreen("success");

} catch (error) {
toast(error.message || "Could not submit the application.");
} finally {
button.disabled = false;
button.textContent = "SUBMIT APPLICATION";
}
}

async function login() {
const phone = normalizePhone($("loginPhone").value);
const pin = $("loginPin").value.trim();
const message = $("loginMessage");

message.textContent = "";

if (!phone) {
message.textContent = "Enter a valid Zimbabwe phone number.";
return;
}

if (!/^\d{4}$/.test(pin)) {
message.textContent = "Enter your 4-digit PIN.";
return;
}

try {
const response = await fetch("/api/login", {
method: "POST",
headers: {
"Content-Type": "application/json"
},
body: JSON.stringify({ phone, pin })
});

const data = await response.json().catch(() => ({}));

if (!response.ok) {
  throw new Error(data.error || "Login failed.");
}

message.style.color = "#13834b";
message.textContent = data.message || "Login successful.";

} catch (error) {
message.style.color = "#c83737";
message.textContent = error.message || "Login failed.";
}
}

updateCalculator();
