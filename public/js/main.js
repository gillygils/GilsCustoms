(function () {
  'use strict';

  // Mobile nav
  var toggle = document.querySelector('.nav-toggle');
  var links = document.getElementById('nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // First-visit intro: remove it when it finishes, or right away on click / Esc.
  var intro = document.querySelector('.intro');
  if (intro && document.documentElement.classList.contains('show-intro')) {
    var finish = function () {
      document.documentElement.classList.remove('show-intro');
    };
    var skip = function () {
      intro.style.animation = 'intro-out 0.35s ease-in forwards';
    };
    intro.addEventListener('animationend', function (e) {
      if (e.target === intro) finish();
    });
    intro.addEventListener('click', skip);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') skip();
    });
  }

  // Footer year
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });

  // Cloudflare Turnstile (spam check). The server only puts a .cf-turnstile box
  // in the forms when it has a site key. The script loads when a form gets
  // close to the screen, so it doesn't slow down the first page load.
  var captchas = document.querySelectorAll('form[data-contact-form] .cf-turnstile');
  var captchaRequested = false;
  function loadCaptcha() {
    if (captchaRequested || !captchas.length) return;
    captchaRequested = true;
    window.gcTurnstileReady = function () {
      captchas.forEach(function (box) {
        box.dataset.widgetId = window.turnstile.render(box, {
          sitekey: box.dataset.sitekey,
          theme: 'dark',
          size: 'flexible',
        });
      });
    };
    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=gcTurnstileReady';
    script.async = true;
    document.head.appendChild(script);
  }
  if (captchas.length) {
    if ('IntersectionObserver' in window) {
      var watcher = new IntersectionObserver(
        function (entries) {
          if (entries.some(function (e) { return e.isIntersecting; })) {
            loadCaptcha();
            watcher.disconnect();
          }
        },
        { rootMargin: '600px 0px' }
      );
      captchas.forEach(function (box) { watcher.observe(box.closest('form')); });
    } else {
      loadCaptcha();
    }
    document.addEventListener('focusin', function (e) {
      if (e.target.closest && e.target.closest('form[data-contact-form]')) loadCaptcha();
    });
  }

  // Contact forms: submit with fetch, fall back to a normal POST without JS.
  document.querySelectorAll('form[data-contact-form]').forEach(function (form) {
    var started = form.querySelector('input[name="started_at"]');
    if (started) started.value = String(Date.now());

    var status = form.querySelector('.form-status');
    var button = form.querySelector('button[type="submit"]');

    function show(msg, ok) {
      status.textContent = msg;
      status.className = 'form-status ' + (ok ? 'ok' : 'err');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;

      var files = form.querySelector('input[type="file"]');
      if (files && files.files.length > 4) {
        show('Please attach no more than 4 photos.', false);
        return;
      }

      var captcha = form.querySelector('.cf-turnstile');
      var token = form.querySelector('input[name="cf-turnstile-response"]');
      if (captcha && !(token && token.value)) {
        loadCaptcha();
        show('Just a second, the spam check is still finishing. Then press Send again.', false);
        return;
      }

      button.disabled = true;
      var label = button.textContent;
      button.textContent = 'Sending...';
      status.textContent = '';

      fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'application/json' },
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (r) {
          if (r.ok) {
            form.reset();
            if (started) started.value = String(Date.now());
            show("Thanks! Your message was sent. I'll get back to you soon.", true);
          } else {
            show(r.data.message || 'Something went wrong. Please try again.', false);
          }
        })
        .catch(function () {
          show('Could not send right now. Please email david@gilscustoms.com instead.', false);
        })
        .finally(function () {
          button.disabled = false;
          button.textContent = label;
          // Each Turnstile pass works once, so get a fresh one for the next send.
          if (captcha && window.turnstile && captcha.dataset.widgetId) {
            window.turnstile.reset(captcha.dataset.widgetId);
          }
        });
    });
  });

  // FAQ: category tabs + search
  var faq = document.querySelector('[data-faq]');
  if (faq) {
    var tabs = Array.prototype.slice.call(faq.querySelectorAll('.faq-cats button'));
    var groups = Array.prototype.slice.call(faq.querySelectorAll('.faq-group'));
    var search = document.getElementById('faq-search');
    var empty = faq.querySelector('.faq-empty');
    var current = groups[0] && groups[0].id;

    function selectCat(id, updateHash) {
      current = id;
      tabs.forEach(function (t) {
        t.setAttribute('aria-selected', String(t.dataset.target === id));
      });
      groups.forEach(function (g) {
        g.hidden = g.id !== id;
        g.querySelectorAll('.faq-item').forEach(function (i) {
          i.hidden = false;
        });
      });
      empty.hidden = true;
      if (updateHash && history.replaceState) history.replaceState(null, '', '#' + id);
    }

    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        if (search.value) {
          search.value = '';
          faq.classList.remove('faq-search-active');
        }
        selectCat(t.dataset.target, true);
      });
    });

    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      if (!q) {
        faq.classList.remove('faq-search-active');
        selectCat(current, false);
        return;
      }
      faq.classList.add('faq-search-active');
      tabs.forEach(function (t) {
        t.setAttribute('aria-selected', 'false');
      });
      var any = false;
      groups.forEach(function (g) {
        var groupHas = false;
        g.querySelectorAll('.faq-item').forEach(function (item) {
          var match = item.textContent.toLowerCase().indexOf(q) !== -1;
          item.hidden = !match;
          if (match) groupHas = true;
        });
        g.hidden = !groupHas;
        if (groupHas) any = true;
      });
      empty.hidden = any;
    });

    var hash = location.hash.slice(1);
    var target = hash && document.getElementById(hash);
    if (target && target.classList.contains('faq-group')) {
      selectCat(hash, false);
    } else if (target && target.classList.contains('faq-item')) {
      selectCat(target.closest('.faq-group').id, false);
      target.open = true;
      target.scrollIntoView();
    } else {
      selectCat(current, false);
    }
  }
})();
