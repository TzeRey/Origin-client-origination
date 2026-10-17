(() => {
  const header = document.querySelector("#siteHeader");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 12);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const formatCount = (value, format) => (format === "comma" ? value.toLocaleString("en-US") : String(value));

  function countUp(el) {
    const target = Number(el.dataset.count);
    const format = el.dataset.format;
    if (reduceMotion) { el.textContent = formatCount(target, format); return; }
    const duration = 1400;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = formatCount(Math.round(target * eased), format);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const counters = document.querySelectorAll("[data-count]");
  counters.forEach((el) => { if (!reduceMotion) el.textContent = "0"; });

  const revealTargets = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    revealTargets.forEach((el) => el.classList.add("is-visible"));
    counters.forEach(countUp);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      entry.target.querySelectorAll("[data-count]").forEach(countUp);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.14, rootMargin: "0px 0px -6% 0px" });
  revealTargets.forEach((el) => observer.observe(el));

  /* Subtle pointer tilt on the hero window. */
  const hero = document.querySelector("#heroWindow");
  if (hero && !reduceMotion && window.matchMedia("(hover: hover)").matches) {
    const holder = hero.parentElement;
    holder.addEventListener("pointermove", (event) => {
      const rect = holder.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      hero.style.animation = "none";
      hero.style.transition = "transform .25s ease-out";
      hero.style.transform = `rotateX(${(-y * 3).toFixed(2)}deg) rotateY(${(x * 4).toFixed(2)}deg)`;
    });
    holder.addEventListener("pointerleave", () => {
      hero.style.transition = "transform .6s cubic-bezier(.22,.8,.2,1)";
      hero.style.transform = "rotateX(0) rotateY(0)";
    });
  }
})();
