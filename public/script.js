const screens=[1,2,3,4,5];function show(n){screens.forEach(i=>document.getElementById("screen"+i).classList.remove("active"));document.getElementById("screen"+n).classList.add("active");window.scrollTo(0,0)}
const amount=document.getElementById("amount"),term=document.getElementById("term");
function money(n){return "USD "+Math.round(n).toLocaleString("en-US")}
function calc(){document.getElementById("amountLabel").textContent=money(+amount.value);document.getElementById("termLabel").textContent="months "+term.value;const r=0.08/12,n=+term.value,p=+amount.value;const pay=p*r/(1-Math.pow(1+r,-n));document.getElementById("paymentLabel").textContent=money(pay)}
amount.addEventListener("input",calc);term.addEventListener("input",calc);calc();

document.getElementById("apply").onclick=()=>show(2);
document.getElementById("step1Next").onclick=()=>{document.getElementById("sumAmount").textContent=money(+(document.getElementById("formAmount").value||100000));document.getElementById("sumPurpose").textContent=document.getElementById("purpose").value||"Sggggg";show(3)};
document.getElementById("step2Next").onclick=()=>{const name=((document.getElementById("firstName").value||"Enock")+" "+(document.getElementById("lastName").value||"Ngetich")).trim();document.getElementById("sumApplicant").textContent=name;show(4)};
document.getElementById("submit").onclick=()=>{show(5)};
document.querySelectorAll("[data-back]").forEach(b=>b.onclick=()=>show(+b.dataset.back));
document.querySelectorAll(".pins input").forEach((el,i,arr)=>el.addEventListener("input",()=>{if(el.value&&arr[i+1])arr[i+1].focus()}));
document.getElementById("loginBtn").onclick=()=>{const t=document.getElementById("toast");t.textContent="Demo login only";t.style.display="block";setTimeout(()=>t.style.display="none",1800)};
