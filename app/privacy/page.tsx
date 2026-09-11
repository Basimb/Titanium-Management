import type { Metadata } from "next";
import Link from "next/link";
import LegalDocument from "@/components/legal-document";

export const metadata: Metadata = {
  title: "سياسة الخصوصية | Titanium Management WhatsApp",
  description: "سياسة خصوصية خدمة Titanium Management WhatsApp لإدارة المهام والتنبيهات.",
};

export default function PrivacyPage() {
  return (
    <LegalDocument
      eyebrow="سياسة الخصوصية · Privacy Policy"
      title="بيانات واضحة لغرض واضح"
      summary="تشرح هذه الصفحة البيانات التي تعالجها خدمة Titanium Management لإدارة مهام الفريق وتشغيل تنبيهات وأوامر WhatsApp."
    >
      <article className="titanium-legal-language" lang="ar" dir="rtl">
        <div className="titanium-legal-language-heading">
          <span>العربية</span>
          <h2>سياسة الخصوصية</h2>
        </div>

        <section>
          <h3><span>01</span> نطاق الخدمة</h3>
          <p>
            Titanium Management أداة داخلية لتنظيم مهام فريق الإدارة. يتيح تكامل WhatsApp
            إرسال التنبيهات والتذكيرات واستقبال تحديثات الموظفين المصرّح لهم. الأوامر الإدارية تبقى لصاحب صلاحية الإدارة فقط.
          </p>
        </section>

        <section>
          <h3><span>02</span> البيانات التي نعالجها</h3>
          <ul>
            <li><strong>بيانات WhatsApp:</strong> رقم المرسل، معرّف الرسالة ونوعها ونصها، وقت المعالجة، ونتيجة تنفيذ الأمر أو حالة الإرسال.</li>
            <li><strong>بيانات النظام الداخلي:</strong> اسم المستخدم ودوره، المهام والتعليقات والمرفقات وسجل النشاط والتواريخ المرتبطة بها.</li>
            <li><strong>الرسائل الصوتية عند تفعيلها:</strong> مقطع عمل قصير حتى دقيقة واحدة يُحوّل إلى نص؛ لا نحفظ ملف الصوت على خادم التطبيق، ونحتفظ بالنص ونتيجة المعالجة كسجل عمل.</li>
            <li><strong>بيانات تقنية أساسية:</strong> قد تعالج خدمات Meta وWhatsApp والاستضافة سجلات الاتصال والأمان اللازمة لتشغيل الخدمة وحمايتها.</li>
          </ul>
          <p>نستلم هذه البيانات منك مباشرة، أو من WhatsApp/Meta عندما تراسل حساب الخدمة.</p>
        </section>

        <section>
          <h3><span>03</span> لماذا نستخدمها</h3>
          <p>
            نستخدم البيانات للتحقق من الصلاحيات، وتنفيذ أوامر المدير، وإدارة المهام، وإرسال التنبيهات،
            ومنع تكرار معالجة الرسائل، وحماية الخدمة وتشخيص الأعطال. لا نستخدمها للإعلانات ولا نبيعها.
          </p>
          <p>يُستخدم Groq لفهم نصوص العمل والعناوين المسموحة وسياق محادثة محدود للشخص نفسه، ولتفريغ المقاطع الصوتية عند تفعيل هذه الميزة. لا نرسل إليه جدول أرقام الموظفين أو مفاتيح الدخول. البحث العام منفصل عن بيانات المهام، وقد يستخدم Groq مزوّد البحث Tavily. ردود الجروب مرئية لأعضائه؛ لا ترسلوا معلومات مرضى أو كلمات مرور أو رموز دخول إلى السكرتير.</p>
        </section>

        <section>
          <h3><span>04</span> المشاركة والاحتفاظ</h3>
          <p>
            تقتصر المشاركة على Meta/WhatsApp ومزوّدي الاستضافة والتقنية بالقدر اللازم لتشغيل الخدمة.
            نحتفظ بالبيانات مدة الحاجة التشغيلية المعقولة لإدارة العمل والأمان، ثم نحذفها أو نقلل ارتباطها
            بالأشخاص عندما لا تعود لازمة.
          </p>
        </section>

        <section>
          <h3><span>05</span> خياراتك وحماية البيانات</h3>
          <p>
            نستخدم ضوابط وصول وصلاحيات والتحقق من هوية مرسل الرسالة وتوقيع الاتصال بين خدمة الربط والموقع. لا توجد وسيلة إلكترونية مضمونة
            بالكامل. يمكنك طلب حذف بياناتك باتباع <Link href="/data-deletion">تعليمات حذف البيانات</Link>.
            لا ترسل كلمة مرور أو رمز تحقق ضمن طلبك.
          </p>
        </section>

        <section>
          <h3><span>06</span> خدمات الطرف الثالث والتحديثات</h3>
          <p>
            يخضع استخدام WhatsApp وMeta أيضاً لسياساتهما الخاصة. قد نحدّث هذه السياسة عند تغير الخدمة،
            وسيظهر تاريخ آخر تحديث أعلى الصفحة.
          </p>
        </section>
      </article>

      <article className="titanium-legal-language titanium-legal-language-en" lang="en" dir="ltr">
        <div className="titanium-legal-language-heading">
          <span>English</span>
          <h2>Privacy Policy</h2>
        </div>

        <section>
          <h3><span>01</span> Service scope</h3>
          <p>
            Titanium Management is an internal task management tool. Its WhatsApp integration
            sends alerts and reminders and accepts updates from authorized staff. Administrative commands remain restricted to the authorized administrator.
          </p>
        </section>

        <section>
          <h3><span>02</span> Data we process</h3>
          <ul>
            <li><strong>WhatsApp data:</strong> sender number, message identifier, type and text, processing time, and the command result or delivery status.</li>
            <li><strong>Internal app data:</strong> user name and role, tasks, comments, attachments, activity records, and related timestamps.</li>
            <li><strong>Voice when enabled:</strong> work voice notes up to one minute are transcribed. The application does not save the audio file to disk; the transcript and processing result form part of the work record.</li>
            <li><strong>Basic technical data:</strong> Meta, WhatsApp, and hosting services may process connection and security logs needed to operate and protect the service.</li>
          </ul>
          <p>We receive this data directly from you or from WhatsApp/Meta when you message the service account.</p>
        </section>

        <section>
          <h3><span>03</span> How we use data</h3>
          <p>
            We use data to authorize access, execute administrator commands, manage tasks, deliver notices,
            prevent duplicate message processing, secure the service, and troubleshoot faults. We do not use
            this data for advertising or sell it.
          </p>
        </section>

        <section>
          <h3><span>04</span> Sharing and retention</h3>
          <p>
            Data is shared only with Meta/WhatsApp and hosting or technology providers as needed to operate
            the service. We keep it for a reasonable operational period needed for team management and security,
            then delete it or reduce its association with individuals when it is no longer needed.
          </p>
          <p>Groq processes work text, authorized task titles and limited same-person conversation context, and transcribes voice when enabled. We do not send the employee phone directory or login credentials to the language planner. Public research is separate from task data and may use Groq&apos;s search provider Tavily. Group replies are visible to group members. Do not send patient information, passwords or login codes to the secretary.</p>
        </section>

        <section>
          <h3><span>05</span> Your choices and security</h3>
          <p>
            We use access controls, permissions, authenticated sender identity and signed bridge requests to protect the system, but no
            electronic method is completely secure. You may request deletion by following our
            {" "}<Link href="/data-deletion">Data Deletion Instructions</Link>. Never include a password or
            verification code in your request.
          </p>
        </section>

        <section>
          <h3><span>06</span> Third-party services and updates</h3>
          <p>
            Your use of WhatsApp and Meta is also governed by their own policies. We may update this policy as
            the service changes; the latest revision date appears at the top of this page.
          </p>
        </section>
      </article>
    </LegalDocument>
  );
}

